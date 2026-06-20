import { extractText } from 'unpdf';
import { assertResolvesToPublic } from '../../permissions/ssrf-guard';
import { htmlToMarkdown } from './extract-html';

/**
 * Tier-1 native `web_fetch` — free, in-bundle, no external service. Fetches a URL
 * and returns clean, LLM-ready text/markdown. Governed + safe:
 * - SSRF: re-resolves the host to a PUBLIC address before EACH hop (manual
 *   redirect following) — a redirect to 169.254.169.254 / 10.x is blocked.
 * - Caps: per-request timeout + a hard byte cap (streamed) + a char cap.
 * - Content-type aware: HTML→markdown (defuddle), PDF→text (unpdf), text/json
 *   passthrough, anything binary rejected.
 * - Sends a fixed honest User-Agent and NO host env/secrets.
 *
 * The `fetchImpl` is injectable so the whole thing is unit-testable offline.
 */
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface WebFetchOptions {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  maxBytes?: number;
  maxChars?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface WebFetchResult {
  url: string;
  title: string;
  markdown: string;
  text: string;
  meta: {
    status: number;
    contentType: string;
    fetchedAt: string;
    bytes: number;
    truncated: boolean;
  };
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT = 'Excalibur/1 (+https://github.com/ExcaliburOSS/excalibur-core)';

export class WebFetchError extends Error {}

/** Composes the caller's signal with a fresh timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Streams the body up to `maxBytes`, cancelling the rest. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const all = Buffer.from(await response.arrayBuffer());
    return all.byteLength > maxBytes
      ? { buf: all.subarray(0, maxBytes), truncated: true }
      : { buf: all, truncated: false };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    if (total + chunk.byteLength > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - total));
      await reader.cancel().catch(() => undefined);
      return { buf: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return { buf: Buffer.concat(chunks), truncated: false };
}

export async function webFetch(
  rawUrl: string,
  opts: WebFetchOptions = {},
): Promise<WebFetchResult> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const signal = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let url = rawUrl;
  let response: Response | undefined;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(url);
    const verdict = await assertResolvesToPublic(parsed.hostname);
    if (!verdict.allowed) {
      throw new WebFetchError(verdict.reason);
    }
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/json,text/plain,application/pdf;q=0.9,*/*;q=0.5',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) break;
      url = new URL(location, url).toString(); // re-checked at the top of the next hop
      continue;
    }
    break;
  }
  if (response === undefined) {
    throw new WebFetchError('No response.');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new WebFetchError(`Too many redirects (>${maxRedirects}).`);
  }
  if (!response.ok) {
    throw new WebFetchError(`HTTP ${response.status} for ${url}`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const { buf, truncated } = await readCapped(response, maxBytes);
  const fetchedAt = new Date().toISOString();
  const meta = {
    status: response.status,
    contentType,
    fetchedAt,
    bytes: buf.byteLength,
    truncated,
  };

  let title = url;
  let markdown: string;
  if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
    const extracted = await htmlToMarkdown(buf.toString('utf8'), url);
    title = extracted.title.length > 0 ? extracted.title : url;
    markdown = extracted.markdown;
  } else if (contentType.includes('application/pdf')) {
    const { text } = await extractText(new Uint8Array(buf), { mergePages: true });
    markdown = (Array.isArray(text) ? text.join('\n') : text).trim();
  } else if (
    contentType.includes('application/json') ||
    contentType.startsWith('text/') ||
    contentType.includes('markdown') ||
    contentType === ''
  ) {
    markdown = buf.toString('utf8').trim();
  } else {
    throw new WebFetchError(
      `Unsupported content-type "${contentType}" (web_fetch returns text only).`,
    );
  }

  const capped =
    markdown.length > maxChars ? `${markdown.slice(0, maxChars)}\n\n…[truncated]` : markdown;
  return { url, title, markdown: capped, text: capped, meta };
}
