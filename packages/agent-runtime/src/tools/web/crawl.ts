import { parseHTML } from 'linkedom';
import type { FetchImpl } from './fetch';
import { RobotsDisallowedError, type PoliteResult } from './polite-fetch';

/**
 * `web_crawl` core (F4): a BOUNDED breadth-first crawl from a seed URL, routed
 * entirely through the injected polite-fetch layer (robots + per-host rate limit
 * + on-disk cache). Hard caps everywhere (maxDepth, maxPages, total bytes,
 * wall-clock) so a crawl can never run away into a DoS / token sink. Every
 * discovered URL is independently gate-checked via `isAllowed` (the caller wires
 * the SSRF/network policy) before it is fetched.
 *
 * Pure + injectable (`politeFetch`, `fetchImpl`, clocks) → unit-tested offline.
 */

export interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
  fromCache: boolean;
}

export interface CrawlStats {
  fetched: number;
  cached: number;
  skippedByRobots: number;
  skippedBlocked: number;
  depthReached: number;
}

export interface CrawlResult {
  pages: CrawlPage[];
  stats: CrawlStats;
}

export interface CrawlOptions {
  maxDepth?: number;
  /** Requested page cap (the caller hard-caps it with `hardMaxPages`). */
  maxPages?: number;
  /** Absolute ceiling from config.crawl.maxPages — `maxPages` can never exceed it. */
  hardMaxPages?: number;
  sameHostOnly?: boolean;
  useSitemap?: boolean;
  /** Injected polite fetch (bound to the run's cache + rate limiter). */
  politeFetch: (url: string) => Promise<PoliteResult>;
  /** Used only to fetch sitemap.xml (kept separate from the page fetcher). */
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  /** Total downloaded-bytes budget (default 8 MiB). */
  maxTotalBytes?: number;
  /** Wall-clock budget in ms (default 60s). */
  deadlineMs?: number;
  /** Per-URL gate (SSRF/network policy). Returns false → the URL is skipped. */
  isAllowed?: (url: string) => boolean;
  now?: () => number;
}

const DEFAULT_MAX_DEPTH = 1;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 60_000;

/** Normalizes a URL for dedupe: drops the hash, lowercases the host. */
export function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const url = base !== undefined ? new URL(raw, base) : new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

/** Extracts absolute http(s) links from markdown (`[text](url)` + bare `<url>`). */
export function extractLinks(markdown: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const mdLink = /\]\((https?:\/\/[^)\s]+)\)/g;
  const bare = /<(https?:\/\/[^>\s]+)>/g;
  for (const re of [mdLink, bare]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) {
      const normalized = normalizeUrl(m[1] as string, baseUrl);
      if (normalized !== null) out.add(normalized);
    }
  }
  return [...out];
}

/** Fetches and parses sitemap.xml `<loc>` entries for the seed origin. */
async function seedFromSitemap(
  origin: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  try {
    const response = await fetchImpl(`${origin}/sitemap.xml`, {
      ...(signal !== undefined ? { signal } : {}),
      headers: { 'User-Agent': 'Excalibur/1' },
    });
    if (!response.ok) return [];
    const { document } = parseHTML(await response.text());
    return [...document.querySelectorAll('loc')]
      .map((node) => normalizeUrl((node.textContent ?? '').trim()))
      .filter((u): u is string => u !== null);
  } catch {
    return [];
  }
}

export async function crawl(startUrl: string, opts: CrawlOptions): Promise<CrawlResult> {
  const now = opts.now ?? Date.now;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const hardCap = opts.hardMaxPages ?? DEFAULT_MAX_PAGES;
  const maxPages = Math.min(opts.maxPages ?? DEFAULT_MAX_PAGES, hardCap);
  const sameHostOnly = opts.sameHostOnly ?? true;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const deadline = now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const seed = normalizeUrl(startUrl);
  const stats: CrawlStats = {
    fetched: 0,
    cached: 0,
    skippedByRobots: 0,
    skippedBlocked: 0,
    depthReached: 0,
  };
  if (seed === null) {
    return { pages: [], stats };
  }
  const seedHost = new URL(seed).hostname;

  const frontier: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }];
  if (opts.useSitemap === true && opts.fetchImpl !== undefined) {
    for (const loc of await seedFromSitemap(new URL(seed).origin, opts.fetchImpl, opts.signal)) {
      frontier.push({ url: loc, depth: 0 });
    }
  }

  const visited = new Set<string>();
  const pages: CrawlPage[] = [];
  let totalBytes = 0;

  while (frontier.length > 0 && pages.length < maxPages) {
    if (opts.signal?.aborted === true || now() > deadline || totalBytes > maxTotalBytes) break;
    const next = frontier.shift();
    if (next === undefined) break;
    const { url, depth } = next;
    if (visited.has(url)) continue;
    visited.add(url);
    if (sameHostOnly && new URL(url).hostname !== seedHost) continue;
    if (opts.isAllowed !== undefined && !opts.isAllowed(url)) {
      stats.skippedBlocked += 1;
      continue;
    }

    let result: PoliteResult;
    try {
      result = await opts.politeFetch(url);
    } catch (error) {
      if (error instanceof RobotsDisallowedError) stats.skippedByRobots += 1;
      continue;
    }
    pages.push({
      url,
      title: result.title,
      markdown: result.markdown,
      fromCache: result.fromCache,
    });
    totalBytes += result.meta.bytes;
    stats.depthReached = Math.max(stats.depthReached, depth);
    if (result.fromCache) stats.cached += 1;
    else stats.fetched += 1;

    if (depth < maxDepth) {
      for (const link of extractLinks(result.markdown, url)) {
        if (!visited.has(link)) frontier.push({ url: link, depth: depth + 1 });
      }
    }
  }

  return { pages, stats };
}
