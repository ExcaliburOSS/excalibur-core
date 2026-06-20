import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './extract-html';
import { webFetch, WebFetchError, type FetchImpl } from './fetch';

// Public IP hosts → the SSRF guard short-circuits with NO real DNS (offline test).
const PUBLIC = 'http://93.184.216.34/';

const HTML = `<!doctype html><html><head><title>Hello Doc</title></head>
<body><nav>site menu</nav><article><h1>Main Heading</h1>
<p>This is the real body text that should survive extraction.</p></article>
<script>window.evil()</script></body></html>`;

/** A fetchImpl returning a fixed Response (per call index). */
function fakeFetch(...responses: Response[]): FetchImpl {
  let i = 0;
  return async () => responses[i++] ?? new Response('end');
}

describe('htmlToMarkdown', () => {
  it('extracts readable content and drops scripts', async () => {
    const { title, markdown } = await htmlToMarkdown(HTML, PUBLIC);
    expect(markdown).toContain('real body text');
    expect(markdown).not.toContain('window.evil');
    expect(title.length).toBeGreaterThan(0);
  });
});

describe('webFetch', () => {
  it('fetches HTML → markdown + title', async () => {
    const res = await webFetch(PUBLIC, {
      fetchImpl: fakeFetch(new Response(HTML, { headers: { 'content-type': 'text/html' } })),
    });
    expect(res.markdown).toContain('real body text');
    expect(res.markdown).not.toContain('window.evil');
    expect(res.meta.contentType).toContain('text/html');
  });

  it('passes JSON / text through', async () => {
    const res = await webFetch(PUBLIC, {
      fetchImpl: fakeFetch(
        new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      ),
    });
    expect(res.markdown).toContain('"ok":true');
  });

  it('rejects unsupported binary content-types', async () => {
    await expect(
      webFetch(PUBLIC, {
        fetchImpl: fakeFetch(
          new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
        ),
      }),
    ).rejects.toBeInstanceOf(WebFetchError);
  });

  it('blocks a redirect to a private/internal address (SSRF)', async () => {
    const res = await webFetch(PUBLIC, {
      fetchImpl: fakeFetch(
        new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
      ),
    }).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    expect(res).toBeInstanceOf(WebFetchError);
    expect(String(res)).toMatch(/blocked|private|internal/i);
  });

  it('enforces the byte cap (truncates large bodies)', async () => {
    const big = 'x'.repeat(5000);
    const res = await webFetch(PUBLIC, {
      maxBytes: 1000,
      fetchImpl: fakeFetch(new Response(big, { headers: { 'content-type': 'text/plain' } })),
    });
    expect(res.meta.truncated).toBe(true);
    expect(res.meta.bytes).toBeLessThanOrEqual(1000);
  });

  it('enforces the char cap', async () => {
    const res = await webFetch(PUBLIC, {
      maxChars: 50,
      fetchImpl: fakeFetch(
        new Response('y'.repeat(5000), { headers: { 'content-type': 'text/plain' } }),
      ),
    });
    expect(res.markdown).toContain('…[truncated]');
    expect(res.markdown.length).toBeLessThan(200);
  });
});
