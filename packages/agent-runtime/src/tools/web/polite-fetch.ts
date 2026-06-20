import { tier1Fetch, type FetchImpl, type WebFetchResult } from './fetch';
import type { WebCache } from './cache';

/**
 * Transversal polite-fetch layer (F4) wrapping the free Tier-1 `tier1Fetch`. It
 * adds the good-citizen behavior a crawler needs WITHOUT re-implementing SSRF
 * (that stays inside `tier1Fetch` / `assertResolvesToPublic`):
 * - per-host token-bucket rate limiting (a min delay between hits to one host),
 * - robots.txt allow/deny + `Crawl-delay` honoring for User-Agent `Excalibur`,
 * - an on-disk cache: a fresh entry (within TTL) is served without a network hit.
 *
 * Everything is injectable (`fetchImpl`, `cache`, `rateLimiter`) so it is unit
 * tested fully offline.
 */

const USER_AGENT_TOKEN = 'excalibur';

export interface RobotsRules {
  /** Disallowed path prefixes that apply to us (UA `Excalibur` ∪ `*`). */
  disallow: string[];
  /** Allowed path prefixes (override a broader disallow). */
  allow: string[];
  /** Crawl-delay in ms, if the site declares one for us. */
  crawlDelayMs?: number;
}

/**
 * Per-host token bucket: serializes requests to a single host with a minimum
 * spacing (`delayMs`), so a crawl never hammers one origin. Cross-host requests
 * are independent. `wait()` resolves once the caller may proceed.
 */
export class RateLimiter {
  private readonly nextAvailable = new Map<string, number>();

  async wait(host: string, delayMs: number, now: () => number = Date.now): Promise<void> {
    const current = now();
    const earliest = this.nextAvailable.get(host) ?? 0;
    const waitMs = Math.max(0, earliest - current);
    // Reserve this host's next slot before sleeping (so concurrent callers queue).
    this.nextAvailable.set(host, Math.max(current, earliest) + Math.max(0, delayMs));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** Parses a robots.txt body into the rules that apply to us (UA `Excalibur` ∪ `*`). */
export function parseRobots(body: string): RobotsRules {
  const lines = body.split('\n').map((l) => l.replace(/#.*$/, '').trim());
  const groups: Array<{ agents: string[]; disallow: string[]; allow: string[]; delay?: number }> =
    [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const line of lines) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (field === 'disallow') {
      if (value.length > 0) current.disallow.push(value);
    } else if (field === 'allow') {
      if (value.length > 0) current.allow.push(value);
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.delay = seconds * 1000;
    }
  }
  // robots.txt precedence: the MOST SPECIFIC matching group wins. If any group
  // names our UA, the wildcard `*` group is ignored entirely (standard behavior).
  const specific = groups.filter((g) => g.agents.some((a) => a.includes(USER_AGENT_TOKEN)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const applicable = specific.length > 0 ? specific : wildcard;
  const rules: RobotsRules = { disallow: [], allow: [] };
  for (const g of applicable) {
    rules.disallow.push(...g.disallow);
    rules.allow.push(...g.allow);
    if (g.delay !== undefined) rules.crawlDelayMs = Math.max(rules.crawlDelayMs ?? 0, g.delay);
  }
  return rules;
}

/** Whether `path` is allowed by the rules (longest-match Allow beats Disallow). */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  const matchLen = (prefixes: string[]): number =>
    prefixes.filter((p) => path.startsWith(p)).reduce((max, p) => Math.max(max, p.length), -1);
  const disallowLen = matchLen(rules.disallow);
  if (disallowLen === -1) return true;
  return matchLen(rules.allow) >= disallowLen;
}

export interface PoliteFetchOptions {
  cache?: WebCache;
  rateLimiter?: RateLimiter;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  /** Honor robots.txt allow/deny + Crawl-delay (default true). */
  respectRobots?: boolean;
  /** Min delay between hits to the same host, ms (overridden by a site Crawl-delay). */
  perHostDelayMs?: number;
  /** Shared robots cache (host → rules) so a crawl fetches robots.txt once per host. */
  robotsCache?: Map<string, RobotsRules>;
  maxBytes?: number;
  maxChars?: number;
}

export class RobotsDisallowedError extends Error {}

/** Fetches and parses robots.txt for a host (cached). Missing/blocked robots → allow-all. */
async function loadRobots(
  origin: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
  cache: Map<string, RobotsRules>,
): Promise<RobotsRules> {
  const cached = cache.get(origin);
  if (cached !== undefined) return cached;
  let rules: RobotsRules = { disallow: [], allow: [] };
  try {
    const response = await fetchImpl(`${origin}/robots.txt`, {
      ...(signal !== undefined ? { signal } : {}),
      headers: { 'User-Agent': 'Excalibur/1' },
    });
    if (response.ok) {
      rules = parseRobots(await response.text());
    }
  } catch {
    // No robots.txt / unreachable → allow-all (standard behavior).
  }
  cache.set(origin, rules);
  return rules;
}

export interface PoliteResult extends WebFetchResult {
  fromCache: boolean;
}

/**
 * Fetches `url` politely: robots check → per-host rate limit → on-disk cache
 * (fresh hit served without network) → `tier1Fetch` + cache write. SSRF is
 * enforced by `tier1Fetch`. Throws {@link RobotsDisallowedError} when robots
 * forbids the path.
 */
export async function politeFetch(
  url: string,
  opts: PoliteFetchOptions = {},
): Promise<PoliteResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const respectRobots = opts.respectRobots ?? true;
  const robotsCache = opts.robotsCache ?? new Map<string, RobotsRules>();
  const parsed = new URL(url);
  const host = parsed.hostname;

  let crawlDelayMs = opts.perHostDelayMs ?? 1000;
  if (respectRobots) {
    const rules = await loadRobots(parsed.origin, fetchImpl, opts.signal, robotsCache);
    if (!robotsAllows(rules, parsed.pathname)) {
      throw new RobotsDisallowedError(`robots.txt disallows ${parsed.pathname} on ${host}`);
    }
    if (rules.crawlDelayMs !== undefined) {
      crawlDelayMs = Math.max(crawlDelayMs, rules.crawlDelayMs);
    }
  }

  // Serve a fresh cached entry without any network hit.
  if (opts.cache !== undefined) {
    const hit = opts.cache.get(url);
    if (hit !== null) {
      return {
        url,
        title: hit.title,
        markdown: hit.markdown,
        text: hit.markdown,
        meta: {
          status: 200,
          contentType: hit.contentType,
          fetchedAt: hit.fetchedAt,
          bytes: hit.bytes,
          truncated: false,
          tier: 'native',
        },
        fromCache: true,
      };
    }
  }

  if (opts.rateLimiter !== undefined) {
    await opts.rateLimiter.wait(host, crawlDelayMs);
  }

  const result = await tier1Fetch(url, {
    fetchImpl,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
  });

  if (opts.cache !== undefined) {
    opts.cache.put(
      url,
      { contentType: result.meta.contentType, title: result.title, bytes: result.meta.bytes },
      result.markdown,
    );
  }
  return { ...result, fromCache: false };
}
