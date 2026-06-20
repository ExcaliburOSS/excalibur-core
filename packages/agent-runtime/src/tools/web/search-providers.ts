import { parseHTML } from 'linkedom';
import type { SearchProviderConfig } from '@excalibur/shared';
import type { FetchImpl } from './fetch';

/**
 * Web-search backends for the native `web_search` tool (F3) — FREE and UNLIMITED
 * by default, with optional BYOK paid upgrades. The whole module is pure +
 * `fetchImpl`-injectable, so the parsers and the provider resolver are unit
 * tested fully offline (no network, no API key, no cost).
 *
 * Free tier (no account, no key, works out of the box):
 *  - `searxng`: a local/remote SearXNG metasearch instance (JSON API). Unlimited
 *    and private. Auto-provisioned via Docker by `searxng-manager.ts`.
 *  - `duckduckgo`: keyless HTML endpoint (`html.duckduckgo.com`). Works on any
 *    machine, best-effort (can throttle). The universal fallback.
 *
 * Paid tier (100% opt-in BYOK — only when `type` names them explicitly):
 *  - `exa` / `tavily` / `brave`: hosted search APIs; the key comes from the
 *    environment variable named by `apiKeyEnv`, never from this repo.
 *
 * `type: 'auto'` resolves FREE-first: local SearXNG when reachable, else
 * DuckDuckGo. It NEVER silently spends a paid key.
 */

export type SearchProviderId = 'searxng' | 'duckduckgo' | 'exa' | 'tavily' | 'brave';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  query: string;
  /** The backend actually used (after `auto` resolution / fallback). */
  provider: SearchProviderId;
  results: SearchResult[];
}

export interface WebSearchOptions {
  /** Resolved search config (defaults applied); omitted → all defaults. */
  config?: SearchProviderConfig;
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  /** Overrides `config.maxResults`. */
  maxResults?: number;
  /** BYOK key for a paid backend (resolved by the caller from `process.env`). */
  apiKey?: string;
  /**
   * A reachable local/remote SearXNG base URL (resolved by the caller via the
   * searxng-manager). When set and `type` is `auto`/`searxng`, it is preferred.
   */
  searxngUrl?: string | null;
  /**
   * Guards a PUBLIC provider host before it is contacted (the network
   * allowlist / SSRF gate). Returns false → that provider is skipped. The LOCAL
   * SearXNG instance is deliberate local infra and bypasses this guard.
   */
  allowHost?: (url: string) => boolean;
}

export class SearchError extends Error {}

const USER_AGENT = 'Excalibur/1 (+https://github.com/ExcaliburOSS/excalibur-core)';
const DUCKDUCKGO_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DEFAULT_MAX_RESULTS = 8;
/** Hard cap so a misconfigured `maxResults` can never balloon a response. */
const HARD_MAX_RESULTS = 25;

function clampMax(value: number | undefined): number {
  const n = value ?? DEFAULT_MAX_RESULTS;
  return Math.max(1, Math.min(HARD_MAX_RESULTS, Math.floor(n)));
}

function resolveFetch(opts: WebSearchOptions): FetchImpl {
  return opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
}

function requestInit(opts: WebSearchOptions, extra: RequestInit = {}): RequestInit {
  return {
    ...extra,
    headers: { 'User-Agent': USER_AGENT, ...(extra.headers ?? {}) },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

// --- SearXNG (free, unlimited) ----------------------------------------------

/** Builds the SearXNG JSON search URL for a base instance URL. */
export function searxngSearchUrl(baseUrl: string, query: string): string {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '0');
  return url.toString();
}

/** Maps a SearXNG JSON payload into normalized results. Exported for tests. */
export function parseSearxngJson(payload: unknown, maxResults: number): SearchResult[] {
  const results =
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as { results?: unknown }).results)
      ? ((payload as { results: unknown[] }).results as Array<Record<string, unknown>>)
      : [];
  const out: SearchResult[] = [];
  for (const r of results) {
    if (out.length >= maxResults) break;
    const url = typeof r['url'] === 'string' ? r['url'].trim() : '';
    if (url.length === 0) continue;
    out.push({
      title: typeof r['title'] === 'string' ? r['title'].trim() : url,
      url,
      snippet: typeof r['content'] === 'string' ? r['content'].trim() : '',
    });
  }
  return out;
}

async function searxngSearch(
  query: string,
  baseUrl: string,
  maxResults: number,
  opts: WebSearchOptions,
): Promise<SearchResult[]> {
  const fetchImpl = resolveFetch(opts);
  const response = await fetchImpl(
    searxngSearchUrl(baseUrl, query),
    requestInit(opts, { headers: { Accept: 'application/json' } }),
  );
  if (!response.ok) {
    throw new SearchError(`SearXNG returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as unknown;
  return parseSearxngJson(payload, maxResults);
}

// --- DuckDuckGo (free, keyless fallback) ------------------------------------

/**
 * Decodes a DuckDuckGo result href. DDG wraps targets in a redirect
 * (`//duckduckgo.com/l/?uddg=<encoded>&rut=…`); the real URL is the `uddg`
 * param. Ad/redirect anchors (`/y.js`) return null and are dropped.
 */
export function decodeDuckDuckGoHref(href: string): string | null {
  const raw = href.trim();
  if (raw.length === 0) return null;
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
  let url: URL;
  try {
    url = new URL(absolute, 'https://duckduckgo.com');
  } catch {
    return null;
  }
  const uddg = url.searchParams.get('uddg');
  if (uddg !== null && uddg.length > 0) {
    return uddg;
  }
  // A DDG internal link without `uddg` (e.g. an ad `/y.js`) is not a real result.
  if (url.hostname.endsWith('duckduckgo.com')) {
    return null;
  }
  return url.toString();
}

/** Parses the DuckDuckGo HTML results page into normalized results. Exported for tests. */
export function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
  const { document } = parseHTML(html);
  const out: SearchResult[] = [];
  for (const node of document.querySelectorAll('div.result')) {
    if (out.length >= maxResults) break;
    const className = node.getAttribute('class') ?? '';
    if (className.includes('result--ad') || className.includes('result--no-result')) {
      continue;
    }
    const anchor = node.querySelector('a.result__a');
    if (anchor === null) continue;
    const url = decodeDuckDuckGoHref(anchor.getAttribute('href') ?? '');
    if (url === null) continue;
    const snippetEl = node.querySelector('.result__snippet');
    out.push({
      title: (anchor.textContent ?? '').trim(),
      url,
      snippet: (snippetEl?.textContent ?? '').trim(),
    });
  }
  return out;
}

async function duckDuckGoSearch(
  query: string,
  maxResults: number,
  opts: WebSearchOptions,
): Promise<SearchResult[]> {
  if (opts.allowHost !== undefined && !opts.allowHost(DUCKDUCKGO_ENDPOINT)) {
    throw new SearchError(
      'DuckDuckGo (html.duckduckgo.com) is not permitted by the network policy; add it to permissions.network.allowedDomains or use a configured provider.',
    );
  }
  const fetchImpl = resolveFetch(opts);
  const url = new URL(DUCKDUCKGO_ENDPOINT);
  url.searchParams.set('q', query);
  const response = await fetchImpl(
    url.toString(),
    requestInit(opts, { headers: { Accept: 'text/html' } }),
  );
  if (!response.ok) {
    throw new SearchError(`DuckDuckGo returned HTTP ${response.status}.`);
  }
  return parseDuckDuckGoHtml(await response.text(), maxResults);
}

// --- Paid backends (BYOK, opt-in) -------------------------------------------

function requireKey(provider: SearchProviderId, opts: WebSearchOptions): string {
  if (opts.apiKey === undefined || opts.apiKey.length === 0) {
    throw new SearchError(
      `The "${provider}" search backend needs an API key. Set search.apiKeyEnv to the name of an environment variable holding the key (BYOK).`,
    );
  }
  return opts.apiKey;
}

function guardPublic(url: string, opts: WebSearchOptions): void {
  if (opts.allowHost !== undefined && !opts.allowHost(url)) {
    throw new SearchError(`Host for ${url} is not permitted by the network policy.`);
  }
}

async function exaSearch(
  query: string,
  maxResults: number,
  opts: WebSearchOptions,
): Promise<SearchResult[]> {
  const key = requireKey('exa', opts);
  const endpoint = opts.config?.baseUrl ?? 'https://api.exa.ai/search';
  guardPublic(endpoint, opts);
  const fetchImpl = resolveFetch(opts);
  const response = await fetchImpl(
    endpoint,
    requestInit(opts, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ query, numResults: maxResults }),
    }),
  );
  if (!response.ok) {
    throw new SearchError(`Exa returned HTTP ${response.status}.`);
  }
  const data = (await response.json()) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? [])
    .slice(0, maxResults)
    .map((r) => ({
      title: typeof r['title'] === 'string' ? r['title'] : String(r['url'] ?? ''),
      url: typeof r['url'] === 'string' ? r['url'] : '',
      snippet: typeof r['text'] === 'string' ? r['text'].trim().slice(0, 400) : '',
    }))
    .filter((r) => r.url.length > 0);
}

async function tavilySearch(
  query: string,
  maxResults: number,
  opts: WebSearchOptions,
): Promise<SearchResult[]> {
  const key = requireKey('tavily', opts);
  const endpoint = opts.config?.baseUrl ?? 'https://api.tavily.com/search';
  guardPublic(endpoint, opts);
  const fetchImpl = resolveFetch(opts);
  const response = await fetchImpl(
    endpoint,
    requestInit(opts, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: maxResults }),
    }),
  );
  if (!response.ok) {
    throw new SearchError(`Tavily returned HTTP ${response.status}.`);
  }
  const data = (await response.json()) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? [])
    .slice(0, maxResults)
    .map((r) => ({
      title: typeof r['title'] === 'string' ? r['title'] : String(r['url'] ?? ''),
      url: typeof r['url'] === 'string' ? r['url'] : '',
      snippet: typeof r['content'] === 'string' ? r['content'].trim() : '',
    }))
    .filter((r) => r.url.length > 0);
}

async function braveSearch(
  query: string,
  maxResults: number,
  opts: WebSearchOptions,
): Promise<SearchResult[]> {
  const key = requireKey('brave', opts);
  const base = opts.config?.baseUrl ?? 'https://api.search.brave.com/res/v1/web/search';
  const url = new URL(base);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  guardPublic(url.toString(), opts);
  const fetchImpl = resolveFetch(opts);
  const response = await fetchImpl(
    url.toString(),
    requestInit(opts, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    }),
  );
  if (!response.ok) {
    throw new SearchError(`Brave returned HTTP ${response.status}.`);
  }
  const data = (await response.json()) as { web?: { results?: Array<Record<string, unknown>> } };
  return (data.web?.results ?? [])
    .slice(0, maxResults)
    .map((r) => ({
      title: typeof r['title'] === 'string' ? r['title'] : String(r['url'] ?? ''),
      url: typeof r['url'] === 'string' ? r['url'] : '',
      snippet: typeof r['description'] === 'string' ? r['description'].trim() : '',
    }))
    .filter((r) => r.url.length > 0);
}

// --- resolver ----------------------------------------------------------------

/**
 * Runs a web search through the resolved backend. `type: 'auto'` (the default)
 * is FREE-first: a reachable local SearXNG (`opts.searxngUrl`) is preferred,
 * otherwise it falls back to keyless DuckDuckGo. Auto NEVER spends a paid key.
 * Explicit `type` uses exactly that backend (paid ones require `apiKey`).
 */
export async function webSearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<WebSearchResponse> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new SearchError('Empty search query.');
  }
  const cfg = opts.config;
  const type = cfg?.type ?? 'auto';
  const maxResults = clampMax(opts.maxResults ?? cfg?.maxResults);

  if (type === 'auto') {
    // Free-first: local SearXNG (unlimited, private) → keyless DuckDuckGo.
    if (opts.searxngUrl !== undefined && opts.searxngUrl !== null && opts.searxngUrl.length > 0) {
      try {
        const results = await searxngSearch(trimmed, opts.searxngUrl, maxResults, opts);
        if (results.length > 0) {
          return { query: trimmed, provider: 'searxng', results };
        }
      } catch {
        // SearXNG hiccup → fall through to DuckDuckGo so search still works.
      }
    }
    const results = await duckDuckGoSearch(trimmed, maxResults, opts);
    return { query: trimmed, provider: 'duckduckgo', results };
  }

  if (type === 'searxng') {
    const baseUrl = cfg?.baseUrl ?? opts.searxngUrl ?? null;
    if (baseUrl === null) {
      throw new SearchError(
        'No SearXNG instance available. Run `excalibur search serve` to start a local one, or set search.baseUrl.',
      );
    }
    const results = await searxngSearch(trimmed, baseUrl, maxResults, opts);
    return { query: trimmed, provider: 'searxng', results };
  }

  if (type === 'duckduckgo') {
    const results = await duckDuckGoSearch(trimmed, maxResults, opts);
    return { query: trimmed, provider: 'duckduckgo', results };
  }

  const paid: Record<
    'exa' | 'tavily' | 'brave',
    (q: string, m: number, o: WebSearchOptions) => Promise<SearchResult[]>
  > = {
    exa: exaSearch,
    tavily: tavilySearch,
    brave: braveSearch,
  };
  const results = await paid[type](trimmed, maxResults, opts);
  return { query: trimmed, provider: type, results };
}
