import type { FetchImpl, TierReader, WebFetchResult } from './fetch';

/**
 * Hosted page readers (F5) — an OPTIONAL, BYOK, PAID escalation tier for
 * `web_fetch`. All providers are plain HTTPS REST reached through the injectable
 * `FetchImpl`, so this module adds ZERO bundled deps and is fully offline-testable
 * with a fake fetch. When no `scrape` provider is configured the product is 100%
 * unchanged (free Tier-1 only); these readers only ever run as a best-effort tier
 * and a failure NEVER aborts a fetch (it falls through to the free floor).
 *
 * Free product invariant: the BYOK key comes from the env var NAMED in config
 * (never the key itself), the key is NEVER placed in a thrown message, and the
 * provider endpoint is governed by the same `allowHost` (SSRF/allowlist) gate.
 */

export type HostedReaderProvider = 'firecrawl' | 'jina' | 'browserbase';

export class HostedReaderError extends Error {}

export interface HostedReaderConfig {
  provider: HostedReaderProvider;
  apiKeyEnv?: string;
  baseUrl?: string;
  timeoutMs?: number;
  jinaKeyless?: boolean;
}

export interface HostedReaderDeps {
  /** Resolved BYOK key (the caller reads it from process.env[apiKeyEnv]). */
  apiKey?: string;
  fetchImpl?: FetchImpl;
  /** Guards the PROVIDER endpoint host (allowlist/SSRF). The target is gated upstream. */
  allowHost?: (url: string) => boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v1/scrape';
const JINA_BASE = 'https://r.jina.ai/';

function result(
  url: string,
  title: string,
  markdown: string,
  provider: HostedReaderProvider,
): WebFetchResult {
  return {
    url,
    title: title.length > 0 ? title : url,
    markdown,
    text: markdown,
    meta: {
      status: 200,
      contentType: 'text/markdown',
      fetchedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(markdown),
      truncated: false,
      tier: `hosted:${provider}`,
    },
  };
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function firecrawlRead(
  url: string,
  cfg: HostedReaderConfig,
  deps: HostedReaderDeps,
  signal: AbortSignal,
): Promise<WebFetchResult | null> {
  if (deps.apiKey === undefined || deps.apiKey.length === 0) {
    return null; // Firecrawl requires a key → skip the tier (fall to free).
  }
  const endpoint = cfg.baseUrl ?? FIRECRAWL_ENDPOINT;
  if (deps.allowHost !== undefined && !deps.allowHost(endpoint)) {
    return null;
  }
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deps.apiKey}`,
    },
    body: JSON.stringify({ url, formats: ['markdown'] }),
  });
  if (!response.ok) {
    throw new HostedReaderError(`Firecrawl HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    data?: { markdown?: string; metadata?: { title?: string } };
  };
  const markdown = data.data?.markdown ?? '';
  if (markdown.length === 0) return null;
  return result(url, data.data?.metadata?.title ?? '', markdown, 'firecrawl');
}

/** Parses Jina reader output (`Title: …\nURL Source: …\nMarkdown Content:\n…`). */
export function parseJinaText(body: string, url: string): WebFetchResult {
  const titleMatch = /^Title:\s*(.+)$/m.exec(body);
  const splitAt = body.indexOf('Markdown Content:');
  const markdown =
    splitAt === -1 ? body.trim() : body.slice(splitAt + 'Markdown Content:'.length).trim();
  return result(
    url,
    titleMatch?.[1]?.trim() ?? '',
    markdown.length > 0 ? markdown : body.trim(),
    'jina',
  );
}

async function jinaRead(
  url: string,
  cfg: HostedReaderConfig,
  deps: HostedReaderDeps,
  signal: AbortSignal,
): Promise<WebFetchResult | null> {
  const hasKey = deps.apiKey !== undefined && deps.apiKey.length > 0;
  if (!hasKey && cfg.jinaKeyless === false) {
    return null; // No key and keyless disabled → skip.
  }
  const base = (cfg.baseUrl ?? JINA_BASE).replace(/\/$/, '');
  const endpoint = `${base}/${url}`;
  if (deps.allowHost !== undefined && !deps.allowHost(base)) {
    return null;
  }
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const response = await fetchImpl(endpoint, {
    signal,
    headers: {
      Accept: 'text/plain',
      ...(hasKey ? { Authorization: `Bearer ${deps.apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    throw new HostedReaderError(`Jina HTTP ${response.status}`);
  }
  const body = await response.text();
  if (body.trim().length === 0) return null;
  return parseJinaText(body, url);
}

/**
 * Builds the hosted-reader {@link TierReader} for the configured provider, or
 * null when the provider cannot operate (no key for a key-required provider).
 * Browserbase is session/browser infrastructure (no one-shot REST scrape) — it
 * declines with a clear error pointing to the free local-browser tier (F4).
 */
export function hostedReaderTier(
  cfg: HostedReaderConfig,
  deps: HostedReaderDeps = {},
): TierReader | null {
  if (cfg.provider === 'firecrawl' && (deps.apiKey === undefined || deps.apiKey.length === 0)) {
    return null;
  }
  if (
    cfg.provider === 'jina' &&
    (deps.apiKey === undefined || deps.apiKey.length === 0) &&
    cfg.jinaKeyless === false
  ) {
    return null;
  }
  return async (url, ctx): Promise<WebFetchResult | null> => {
    const signal = timeoutSignal(ctx.signal, cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    switch (cfg.provider) {
      case 'firecrawl':
        return firecrawlRead(url, cfg, deps, signal);
      case 'jina':
        return jinaRead(url, cfg, deps, signal);
      case 'browserbase':
        // Browserbase is a hosted browser you DRIVE (no one-shot scrape REST);
        // its capability is covered by the free local-browser tier (F4).
        throw new HostedReaderError(
          'Browserbase is session-based; use the local browser (`excalibur browser enable`) or firecrawl/jina.',
        );
    }
  };
}
