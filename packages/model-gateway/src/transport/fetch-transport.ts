/**
 * Production `HttpTransport` backed by the global `fetch` (Node >= 22).
 *
 * The body stream is decoded into newline-delimited text lines with cross-chunk
 * buffering so SSE / ndjson parsing sees whole lines even when the network
 * splits a line across two chunks. Tests never construct this: they inject a
 * fake `HttpTransport` (or a fake `fetchImpl`) instead, keeping the suite
 * offline.
 */

import type { HttpTransport, TransportRequest, TransportResponse } from './transport';

/** Decodes a `ReadableStream<Uint8Array>` into newline-delimited text lines. */
async function* decodeLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        // Strip a trailing CR so CRLF streams yield clean lines.
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        yield line;
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    }
    // Flush any decoder remainder, then the final unterminated line.
    buffer += decoder.decode();
    const tail = buffer.replace(/\r$/, '');
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

/**
 * Builds an `HttpTransport` over `fetchImpl` (defaults to the global `fetch`).
 * Injecting a custom `fetchImpl` lets tests stub the network at the fetch
 * boundary while still exercising the real line-decoding logic.
 */
export function createFetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return {
    async send(request: TransportRequest): Promise<TransportResponse> {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
      };
      if (request.body !== undefined) {
        init.body = request.body;
      }
      if (request.signal !== undefined) {
        init.signal = request.signal;
      }
      const response = await fetchImpl(request.url, init);
      const headers = headersToObject(response.headers);
      let bufferedText: string | null = null;
      return {
        status: response.status,
        ok: response.ok,
        headers,
        async text(): Promise<string> {
          if (bufferedText === null) {
            bufferedText = await response.text();
          }
          return bufferedText;
        },
        lines(): AsyncIterable<string> {
          const body = response.body;
          if (body === null) {
            // No streamable body — fall back to buffering then splitting.
            return (async function* fromText(): AsyncIterable<string> {
              const text = await response.text();
              for (const line of text.split('\n')) {
                yield line.replace(/\r$/, '');
              }
            })();
          }
          return decodeLines(body);
        },
      };
    },
  };
}
