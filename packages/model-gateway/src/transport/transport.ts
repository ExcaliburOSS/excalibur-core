/**
 * HTTP transport abstraction for real model provider adapters (OSS-4, M2).
 *
 * Providers never touch `fetch` directly: they go through an injected
 * `HttpTransport`. This keeps adapters 100% testable offline — tests supply a
 * fake transport returning canned fixture bodies, so no network call, API key
 * or cost is ever incurred in the suite. The production transport
 * (`createFetchTransport`) wraps the global `fetch`.
 */

/** A single HTTP request issued by an adapter. */
export interface TransportRequest {
  url: string;
  method: 'GET' | 'POST';
  /** Header name → value. Secret values (API keys) live here at call time only. */
  headers: Record<string, string>;
  /** Pre-serialized request body (JSON string for these adapters). */
  body?: string;
  /** Abort signal composed from timeout + caller signal by the base provider. */
  signal?: AbortSignal;
}

/**
 * A streamed-or-buffered HTTP response.
 *
 * `text()` buffers the whole body (non-stream calls). `lines()` yields the body
 * decoded into newline-delimited text lines with cross-chunk buffering, which
 * `parseSSE` / `parseNdjson` consume for streaming calls. A given response is
 * consumed by exactly one of the two — never both.
 */
export interface TransportResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  lines(): AsyncIterable<string>;
}

/** The single dependency every real adapter is constructed with. */
export interface HttpTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}
