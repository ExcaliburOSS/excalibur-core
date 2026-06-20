import { describe, expect, it } from 'vitest';
import type { SearchProviderConfig } from '@excalibur/shared';
import type { FetchImpl } from './fetch';
import {
  SearchError,
  decodeDuckDuckGoHref,
  parseDuckDuckGoHtml,
  parseSearxngJson,
  searxngSearchUrl,
  webSearch,
} from './search-providers';

const DDG_HTML = `<!doctype html><html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example Docs</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The canonical example documentation page.</a>
  </div>
</div>
<div class="result results_links result--ad">
  <div class="links_main"><a class="result__a" href="//duckduckgo.com/y.js?ad=1">Buy now</a></div>
</div>
<div class="result results_links web-result">
  <div class="links_main">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2F">Example Org</a>
    <a class="result__snippet">Another result snippet.</a>
  </div>
</div>
</body></html>`;

/** A fetchImpl driven by a per-call handler. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response): FetchImpl {
  return async (url, init) => handler(url, init);
}

describe('decodeDuckDuckGoHref', () => {
  it('unwraps the uddg redirect param', () => {
    expect(
      decodeDuckDuckGoHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=x'),
    ).toBe('https://example.com/');
  });

  it('drops ad / internal links without a uddg target', () => {
    expect(decodeDuckDuckGoHref('//duckduckgo.com/y.js?ad=1')).toBeNull();
    expect(decodeDuckDuckGoHref('')).toBeNull();
  });

  it('passes a direct external URL through', () => {
    expect(decodeDuckDuckGoHref('https://example.com/page')).toBe('https://example.com/page');
  });
});

describe('parseDuckDuckGoHtml', () => {
  it('extracts results, decodes targets, and drops ads', () => {
    const results = parseDuckDuckGoHtml(DDG_HTML, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Example Docs',
      url: 'https://example.com/docs',
      snippet: 'The canonical example documentation page.',
    });
    expect(results.some((r) => r.title === 'Buy now')).toBe(false);
  });

  it('honours the maxResults cap', () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1);
  });
});

describe('parseSearxngJson', () => {
  it('maps url/title/content and caps results', () => {
    const payload = {
      results: [
        { url: 'https://a.test', title: 'A', content: 'snippet a' },
        { url: 'https://b.test', title: 'B', content: 'snippet b' },
        { title: 'no url — dropped' },
      ],
    };
    const results = parseSearxngJson(payload, 5);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ url: 'https://a.test', title: 'A', snippet: 'snippet a' });
  });

  it('returns [] for a malformed payload', () => {
    expect(parseSearxngJson(null, 5)).toEqual([]);
    expect(parseSearxngJson({ results: 'nope' }, 5)).toEqual([]);
  });
});

describe('searxngSearchUrl', () => {
  it('builds a JSON search URL', () => {
    const url = searxngSearchUrl('http://127.0.0.1:8899', 'hello world');
    expect(url).toContain('/search?');
    expect(url).toContain('q=hello+world');
    expect(url).toContain('format=json');
  });
});

const SEARXNG_RESPONSE = (): Response =>
  new Response(
    JSON.stringify({ results: [{ url: 'https://sx.test', title: 'SX', content: 'via searxng' }] }),
    {
      headers: { 'content-type': 'application/json' },
    },
  );
const DDG_RESPONSE = (): Response =>
  new Response(DDG_HTML, { headers: { 'content-type': 'text/html' } });

describe('webSearch (auto, free-first)', () => {
  it('prefers a reachable local SearXNG', async () => {
    const res = await webSearch('test', {
      searxngUrl: 'http://127.0.0.1:8899',
      fetchImpl: fakeFetch((url) =>
        url.includes('127.0.0.1') ? SEARXNG_RESPONSE() : DDG_RESPONSE(),
      ),
    });
    expect(res.provider).toBe('searxng');
    expect(res.results[0]?.url).toBe('https://sx.test');
  });

  it('falls back to DuckDuckGo when SearXNG errors', async () => {
    const res = await webSearch('test', {
      searxngUrl: 'http://127.0.0.1:8899',
      fetchImpl: fakeFetch((url) =>
        url.includes('127.0.0.1') ? new Response('boom', { status: 500 }) : DDG_RESPONSE(),
      ),
    });
    expect(res.provider).toBe('duckduckgo');
    expect(res.results[0]?.url).toBe('https://example.com/docs');
  });

  it('uses DuckDuckGo directly when no SearXNG is available', async () => {
    const res = await webSearch('test', { fetchImpl: fakeFetch(() => DDG_RESPONSE()) });
    expect(res.provider).toBe('duckduckgo');
    expect(res.results.length).toBeGreaterThan(0);
  });
});

describe('webSearch (explicit + guards)', () => {
  it('rejects an empty query', async () => {
    await expect(webSearch('  ', {})).rejects.toBeInstanceOf(SearchError);
  });

  it('throws for type=searxng with no instance', async () => {
    const config = { type: 'searxng', maxResults: 8, manageSearxng: true } as SearchProviderConfig;
    await expect(webSearch('x', { config })).rejects.toBeInstanceOf(SearchError);
  });

  it('blocks DuckDuckGo when allowHost rejects it', async () => {
    await expect(
      webSearch('x', { fetchImpl: fakeFetch(() => DDG_RESPONSE()), allowHost: () => false }),
    ).rejects.toBeInstanceOf(SearchError);
  });

  it('paid backend requires an API key', async () => {
    const config = { type: 'exa', maxResults: 8, manageSearxng: true } as SearchProviderConfig;
    await expect(webSearch('x', { config })).rejects.toBeInstanceOf(SearchError);
  });

  it('paid backend (exa) sends the BYOK key in a header', async () => {
    const config = { type: 'exa', maxResults: 5, manageSearxng: true } as SearchProviderConfig;
    let seenKey: string | undefined;
    const res = await webSearch('x', {
      config,
      apiKey: 'secret-key',
      fetchImpl: fakeFetch((_url, init) => {
        seenKey = (init?.headers as Record<string, string> | undefined)?.['x-api-key'];
        return new Response(
          JSON.stringify({ results: [{ url: 'https://exa.test', title: 'E', text: 't' }] }),
          {
            headers: { 'content-type': 'application/json' },
          },
        );
      }),
    });
    expect(seenKey).toBe('secret-key');
    expect(res.provider).toBe('exa');
    expect(res.results[0]?.url).toBe('https://exa.test');
  });
});
