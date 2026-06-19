/**
 * Test doubles for the HTTP transport so adapters run 100% offline — no
 * network, no API key, no cost. Used only by the test suite.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpTransport, TransportRequest, TransportResponse } from '../transport/transport';

const FIXTURES_DIR = __dirname;

/** Reads a fixture body from this directory by file name. */
export function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

export interface FakeResponseSpec {
  status?: number;
  ok?: boolean;
  headers?: Record<string, string>;
  /** Full response body (buffered via `text()` and split into `lines()`). */
  body: string;
}

/** Builds a `TransportResponse` from a canned spec. */
export function fakeResponse(spec: FakeResponseSpec): TransportResponse {
  const status = spec.status ?? 200;
  const ok = spec.ok ?? (status >= 200 && status < 300);
  const headers = spec.headers ?? {};
  const body = spec.body;
  return {
    status,
    ok,
    headers,
    async text(): Promise<string> {
      return body;
    },
    lines(): AsyncIterable<string> {
      return (async function* iterate(): AsyncIterable<string> {
        // Split on \n; keep behavior identical to the real line decoder.
        const parts = body.split('\n');
        for (let i = 0; i < parts.length; i += 1) {
          // Drop a trailing empty segment from a final newline.
          if (i === parts.length - 1 && parts[i] === '') {
            continue;
          }
          yield (parts[i] ?? '').replace(/\r$/, '');
        }
      })();
    },
  };
}

/** Records every request the adapter issues, for assertions. */
export interface RecordedRequest {
  request: TransportRequest;
}

/**
 * A transport returning queued responses in order. Each `send` records the
 * request (including headers and body) and returns the next queued response;
 * once the queue is exhausted the last response is repeated.
 */
export class QueueTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  private readonly queue: TransportResponse[];

  constructor(responses: TransportResponse[]) {
    if (responses.length === 0) {
      throw new Error('QueueTransport requires at least one response');
    }
    this.queue = [...responses];
  }

  get sendCount(): number {
    return this.requests.length;
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push({ request });
    const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
    return next as TransportResponse;
  }
}

/** A transport whose `send` is a supplied function (for throwing/abort cases). */
export class FnTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];

  constructor(
    private readonly fn: (request: TransportRequest, index: number) => Promise<TransportResponse>,
  ) {}

  get sendCount(): number {
    return this.requests.length;
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const index = this.requests.length;
    this.requests.push({ request });
    return this.fn(request, index);
  }
}

/** Deterministic no-op timing seams for retry/backoff in tests. */
export const deterministicHooks = {
  sleep: async (): Promise<void> => {},
  random: (): number => 0.5,
};
