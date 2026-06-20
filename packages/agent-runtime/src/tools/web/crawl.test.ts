import { describe, expect, it } from 'vitest';
import { crawl, extractLinks, normalizeUrl } from './crawl';
import { RobotsDisallowedError, type PoliteResult } from './polite-fetch';

function page(url: string, markdown: string, fromCache = false): PoliteResult {
  return {
    url,
    title: url,
    markdown,
    text: markdown,
    meta: {
      status: 200,
      contentType: 'text/html',
      fetchedAt: '2026-06-20T00:00:00.000Z',
      bytes: markdown.length,
      truncated: false,
      tier: 'native',
    },
    fromCache,
  };
}

describe('normalizeUrl', () => {
  it('drops the hash and lowercases the host', () => {
    expect(normalizeUrl('https://Example.com/a#frag')).toBe('https://example.com/a');
  });
  it('rejects non-http(s)', () => {
    expect(normalizeUrl('mailto:x@y.z')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('extractLinks', () => {
  it('extracts markdown + bare links and dedupes', () => {
    const md =
      'see [docs](https://h.test/docs) and <https://h.test/changelog> and [dup](https://h.test/docs)';
    const links = extractLinks(md, 'https://h.test/');
    expect(links).toContain('https://h.test/docs');
    expect(links).toContain('https://h.test/changelog');
    expect(links.filter((l) => l === 'https://h.test/docs')).toHaveLength(1);
  });
});

describe('crawl', () => {
  const fetcher =
    (markdownByUrl: Record<string, string>) =>
    async (url: string): Promise<PoliteResult> => {
      const md = markdownByUrl[url];
      if (md === undefined) throw new Error(`unexpected ${url}`);
      return page(url, md);
    };

  it('does a bounded BFS following same-host links', async () => {
    const md = {
      'https://h.test/': 'root [a](https://h.test/a) [b](https://h.test/b)',
      'https://h.test/a': 'page a',
      'https://h.test/b': 'page b',
    };
    const result = await crawl('https://h.test/', {
      maxDepth: 1,
      maxPages: 10,
      politeFetch: fetcher(md),
    });
    expect(result.pages.map((p) => p.url).sort()).toEqual([
      'https://h.test/',
      'https://h.test/a',
      'https://h.test/b',
    ]);
    expect(result.stats.fetched).toBe(3);
  });

  it('respects maxPages', async () => {
    const md = {
      'https://h.test/': 'root [a](https://h.test/a) [b](https://h.test/b)',
      'https://h.test/a': 'a',
      'https://h.test/b': 'b',
    };
    const result = await crawl('https://h.test/', {
      maxDepth: 1,
      maxPages: 2,
      politeFetch: fetcher(md),
    });
    expect(result.pages).toHaveLength(2);
  });

  it('stays on the seed host when sameHostOnly', async () => {
    const md = { 'https://h.test/': 'root [ext](https://other.test/x)' };
    const result = await crawl('https://h.test/', {
      maxDepth: 1,
      politeFetch: fetcher(md),
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.url).toBe('https://h.test/');
  });

  it('counts robots-skipped pages without failing', async () => {
    const politeFetch = async (url: string): Promise<PoliteResult> => {
      if (url.endsWith('/blocked')) throw new RobotsDisallowedError('nope');
      return page(url, 'root [x](https://h.test/blocked)');
    };
    const result = await crawl('https://h.test/', { maxDepth: 1, politeFetch });
    expect(result.stats.skippedByRobots).toBe(1);
    expect(result.pages).toHaveLength(1);
  });

  it('skips URLs rejected by isAllowed (SSRF gate)', async () => {
    const md = { 'https://h.test/': 'root [bad](https://h.test/internal)' };
    const result = await crawl('https://h.test/', {
      maxDepth: 1,
      politeFetch: fetcher(md),
      isAllowed: (u) => !u.endsWith('/internal'),
    });
    expect(result.stats.skippedBlocked).toBe(1);
    expect(result.pages).toHaveLength(1);
  });
});
