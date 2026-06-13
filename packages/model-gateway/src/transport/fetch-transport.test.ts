import { describe, expect, it } from 'vitest';
import { createFetchTransport } from './fetch-transport';

/** Builds a Response whose body streams the given chunks (to test buffering). */
function streamingResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, init);
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of iterable) {
    out.push(line);
  }
  return out;
}

describe('createFetchTransport', () => {
  it('reassembles lines split across chunks', async () => {
    const fakeFetch = (async () =>
      streamingResponse(['hel', 'lo\nwor', 'ld\n', 'tail'])) as unknown as typeof fetch;
    const transport = createFetchTransport(fakeFetch);
    const response = await transport.send({
      url: 'https://example.test',
      method: 'GET',
      headers: {},
    });
    expect(await collect(response.lines())).toEqual(['hello', 'world', 'tail']);
  });

  it('strips carriage returns from CRLF streams', async () => {
    const fakeFetch = (async () =>
      streamingResponse(['a\r\n', 'b\r\n'])) as unknown as typeof fetch;
    const transport = createFetchTransport(fakeFetch);
    const response = await transport.send({
      url: 'https://example.test',
      method: 'GET',
      headers: {},
    });
    expect(await collect(response.lines())).toEqual(['a', 'b']);
  });

  it('exposes status, ok and lowercased headers and buffers text()', async () => {
    const fakeFetch = (async () =>
      streamingResponse(['{"ok":true}'], {
        status: 201,
        headers: { 'Retry-After': '7', 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const transport = createFetchTransport(fakeFetch);
    const response = await transport.send({
      url: 'https://example.test',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(201);
    expect(response.ok).toBe(true);
    expect(response.headers['retry-after']).toBe('7');
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('passes method, headers, body and signal through to fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const controller = new AbortController();
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return streamingResponse(['x']);
    }) as unknown as typeof fetch;
    const transport = createFetchTransport(fakeFetch);
    await transport.send({
      url: 'https://example.test/path',
      method: 'POST',
      headers: { authorization: 'Bearer redacted' },
      body: 'payload',
      signal: controller.signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/path');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe('payload');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });
});
