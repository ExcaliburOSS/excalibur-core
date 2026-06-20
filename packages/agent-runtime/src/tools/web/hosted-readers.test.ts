import { describe, expect, it } from 'vitest';
import type { FetchImpl } from './fetch';
import { HostedReaderError, hostedReaderTier, parseJinaText } from './hosted-readers';

const TARGET = 'https://example.com/';
const CTX = { maxBytes: 2_000_000, maxChars: 50_000 };

/** A fetchImpl that records the request and returns a canned Response. */
function spyFetch(response: Response): {
  fetchImpl: FetchImpl;
  seen: { url: string; init?: RequestInit }[];
} {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchImpl = async (url, init) => {
    seen.push({ url, ...(init !== undefined ? { init } : {}) });
    return response;
  };
  return { fetchImpl, seen };
}

describe('hostedReaderTier — firecrawl', () => {
  it('returns null (skips the tier) without a key', () => {
    expect(hostedReaderTier({ provider: 'firecrawl' }, {})).toBeNull();
  });

  it('POSTs with the bearer key and parses markdown + title', async () => {
    const { fetchImpl, seen } = spyFetch(
      new Response(
        JSON.stringify({ data: { markdown: '# Hi\n\nbody', metadata: { title: 'Hi' } } }),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const reader = hostedReaderTier({ provider: 'firecrawl' }, { apiKey: 'fc-key', fetchImpl });
    const res = await reader?.(TARGET, CTX);
    expect(res?.meta.tier).toBe('hosted:firecrawl');
    expect(res?.markdown).toContain('body');
    expect(res?.title).toBe('Hi');
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer fc-key');
    expect(String(seen[0]?.init?.body)).toContain('"url"');
  });

  it('never leaks the key in an error message', async () => {
    const { fetchImpl } = spyFetch(new Response('nope', { status: 500 }));
    const reader = hostedReaderTier(
      { provider: 'firecrawl' },
      { apiKey: 'super-secret-key', fetchImpl },
    );
    const err = await reader?.(TARGET, CTX).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HostedReaderError);
    expect(String(err)).not.toContain('super-secret-key');
  });
});

describe('hostedReaderTier — jina', () => {
  it('works key-less (GET, no Authorization) and parses the reader format', async () => {
    const body =
      'Title: Example\nURL Source: https://example.com/\n\nMarkdown Content:\nthe body text';
    const { fetchImpl, seen } = spyFetch(
      new Response(body, { headers: { 'content-type': 'text/plain' } }),
    );
    const reader = hostedReaderTier({ provider: 'jina', jinaKeyless: true }, { fetchImpl });
    const res = await reader?.(TARGET, CTX);
    expect(res?.meta.tier).toBe('hosted:jina');
    expect(res?.title).toBe('Example');
    expect(res?.markdown).toBe('the body text');
    expect(seen[0]?.url).toBe('https://r.jina.ai/https://example.com/');
    const headers = (seen[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('skips when no key and keyless disabled', () => {
    expect(hostedReaderTier({ provider: 'jina', jinaKeyless: false }, {})).toBeNull();
  });

  it('sends Authorization when a key is provided', async () => {
    const { fetchImpl, seen } = spyFetch(new Response('Markdown Content:\nx'));
    const reader = hostedReaderTier({ provider: 'jina' }, { apiKey: 'jina-key', fetchImpl });
    await reader?.(TARGET, CTX);
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jina-key');
  });
});

describe('hostedReaderTier — guards & browserbase', () => {
  it('returns null when allowHost rejects the provider endpoint', async () => {
    const { fetchImpl } = spyFetch(new Response('{}'));
    const reader = hostedReaderTier(
      { provider: 'firecrawl' },
      { apiKey: 'k', fetchImpl, allowHost: () => false },
    );
    expect(await reader?.(TARGET, CTX)).toBeNull();
  });

  it('browserbase declines with a clear error (use the local browser)', async () => {
    const reader = hostedReaderTier({ provider: 'browserbase' }, { apiKey: 'bb' });
    await expect(reader?.(TARGET, CTX)).rejects.toBeInstanceOf(HostedReaderError);
  });
});

describe('parseJinaText', () => {
  it('falls back to the whole body when no Markdown Content marker', () => {
    const res = parseJinaText('just some text', TARGET);
    expect(res.markdown).toBe('just some text');
    expect(res.title).toBe(TARGET);
  });
});
