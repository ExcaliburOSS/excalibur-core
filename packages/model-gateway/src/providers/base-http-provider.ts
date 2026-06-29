/**
 * Shared base for the real HTTP provider adapters (OSS-4, M2).
 *
 * Composes transport + retry + timeout + redaction + usage normalization, and
 * defines small abstract hooks each concrete adapter fills (request building,
 * non-stream parsing, stream decoding). Retries wrap `chat()` and the INITIAL
 * connect of `stream()` only — never mid-stream, so a partially consumed stream
 * is never silently replayed.
 *
 * Secret handling: the API key is resolved once in the constructor (from an env
 * var via `resolveApiKey`) and never persisted, logged, or placed in any error
 * `details`. Error bodies are redacted by `mapHttpError` before storage.
 */

import { ConfigValidationError, ProviderError } from '@excalibur/shared';
import {
  isRetryableProviderError,
  isTimeoutError,
  mapHttpError,
  networkError,
  timeoutError,
} from '../errors/provider-errors';
import { normalizeUsage } from '../cost/token-accounting';
import { withRetry } from '../transport/retry';
import { isTimeoutAbort, withTimeout } from '../transport/timeout';
import type { HttpTransport, TransportRequest, TransportResponse } from '../transport/transport';
import type {
  ChatDelta,
  ChatFinishReason,
  ChatInput,
  ChatOutput,
  ChatUsage,
  ModelProviderAdapter,
  ToolCall,
  ToolCallDelta,
} from '../types';
import type { ProviderConfig } from './providers-file';
import { resolveApiKey } from './providers-file';

/** Default timeout and retry budget when the provider config omits them. */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
/**
 * Stream IDLE timeout floor (RUN-FIX-21). The per-request timeout only covers the
 * CONNECT of a streaming call; once bytes flow it is released, so a model that STALLS
 * mid-response (or "thinks" forever before the first token) would otherwise hang the
 * stream — and a streamed build call FOREVER. We abort the stream when NO delta has
 * arrived for this long. Generous enough for a slow reasoning model's first token,
 * tight enough that a true stall never freezes the shell. A provider's configured
 * `timeoutMs`, if larger, wins.
 */
const STREAM_IDLE_FLOOR_MS = 180_000;

/** Parsed result of a non-streaming chat response. */
export interface ParsedChatResponse {
  content: string;
  usage: Partial<ChatUsage>;
  finishReason: ChatFinishReason;
  model: string;
  /**
   * Tool calls the model requested (function calling). Present only when the
   * response was a tool-call turn; `content` may then be empty and
   * `finishReason` is `'tool_calls'`. Absent for text-only completions.
   */
  toolCalls?: ToolCall[];
}

/** Test/timing seams shared with `withRetry`, injectable for determinism. */
export interface BaseProviderHooks {
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

export interface BaseHttpProviderOptions {
  name: string;
  cfg: ProviderConfig;
  transport: HttpTransport;
  /** Whether an API key is mandatory (anthropic / openai-compatible) or not (ollama). */
  requiresApiKey: boolean;
  /**
   * Pre-resolved API key injected by the caller (OSS-4, M2). When provided it
   * wins over env-var resolution — enabling hosts that keep keys outside the
   * process environment (e.g. encrypted in a database) to supply the decrypted
   * key in-memory. When omitted, the key is resolved from `cfg.apiKeyEnv` via
   * `resolveApiKey` exactly as before. Like the env-resolved key, an injected
   * key is never persisted, logged, or placed in any error `details`.
   */
  apiKey?: string;
  hooks?: BaseProviderHooks;
}

export abstract class BaseHttpProvider implements ModelProviderAdapter {
  readonly name: string;
  protected readonly cfg: ProviderConfig;
  protected readonly apiKey: string | null;
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly hooks: BaseProviderHooks;

  constructor(options: BaseHttpProviderOptions) {
    this.name = options.name;
    this.cfg = options.cfg;
    this.transport = options.transport;
    this.hooks = options.hooks ?? {};
    this.timeoutMs = options.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.cfg.maxRetries ?? DEFAULT_MAX_RETRIES;

    // An explicitly injected key wins; otherwise fall back to the env var named
    // in `apiKeyEnv` (the OSS default). An empty injected string is treated as
    // "not provided" so the env fallback and the requiresApiKey guard still apply.
    this.apiKey =
      options.apiKey !== undefined && options.apiKey.length > 0
        ? options.apiKey
        : resolveApiKey(options.cfg);
    if (options.requiresApiKey && this.apiKey === null) {
      const envHint =
        options.cfg.apiKeyEnv !== undefined && options.cfg.apiKeyEnv.length > 0
          ? `Set the "${options.cfg.apiKeyEnv}" environment variable.`
          : 'Set "apiKeyEnv" in providers.yaml to the name of the environment variable holding the key.';
      throw new ConfigValidationError(
        `Provider "${options.name}" (type "${options.cfg.type}") requires an API key but none is configured. ${envHint}`,
        { provider: options.name, type: options.cfg.type },
      );
    }
  }

  // --- Hooks each concrete adapter fills -----------------------------------

  /** Builds the non-streaming request (without the abort signal). */
  protected abstract buildChatRequest(input: ChatInput, model: string): TransportRequest;

  /** Builds the streaming request (without the abort signal). */
  protected abstract buildStreamRequest(input: ChatInput, model: string): TransportRequest;

  /** Parses a successful non-streaming response body. */
  protected abstract parseChatResponse(text: string, model: string): ParsedChatResponse;

  /**
   * Decodes a successful streaming response into content/usage events. Yields
   * `{ content }` chunks (concatenation === full content) and may yield a final
   * usage object. The base class appends the terminal `{ content: '', done:true }`.
   */
  protected abstract decodeStream(
    response: TransportResponse,
    input: ChatInput,
    model: string,
  ): AsyncIterable<StreamEvent>;

  /** Effective timeout for a request: per-call override → provider config default. */
  private effectiveTimeoutMs(input: ChatInput): number {
    return input.timeoutMs !== undefined && input.timeoutMs > 0 ? input.timeoutMs : this.timeoutMs;
  }

  /**
   * Idle window for a streaming response (RUN-FIX-21): how long with NO delta before
   * the stream is treated as stalled and aborted. An explicit per-request `timeoutMs`
   * is honoured as-is (so callers/tests can tighten it); otherwise we floor the
   * provider's configured timeout to {@link STREAM_IDLE_FLOOR_MS} so a slow reasoning
   * model's first-token latency never trips it.
   */
  private effectiveStreamIdleMs(input: ChatInput): number {
    return input.timeoutMs !== undefined && input.timeoutMs > 0
      ? input.timeoutMs
      : Math.max(this.timeoutMs, STREAM_IDLE_FLOOR_MS);
  }

  /** Resolves the model name to send (explicit input → config default). */
  protected resolveModel(input: ChatInput): string {
    const model = input.model ?? this.cfg.model;
    if (model === undefined || model.length === 0) {
      throw new ProviderError(
        `No model specified for provider "${this.name}". Set "model" in providers.yaml or pass one in the request.`,
        { code: 'invalid_request', details: { provider: this.name } },
      );
    }
    return model;
  }

  // --- Public adapter surface ----------------------------------------------

  async chat(input: ChatInput): Promise<ChatOutput> {
    const model = this.resolveModel(input);
    // The retried unit sends the request AND reads/validates the response, so a
    // retryable HTTP status (429/5xx) is thrown inside the retry loop.
    const body = await withRetry(
      async () => {
        const response = await this.send(this.buildChatRequest(input, model), input);
        const text = await response.text();
        if (!response.ok) {
          throw mapHttpError(response.status, text, response.headers);
        }
        return text;
      },
      {
        maxRetries: this.maxRetries,
        isRetryable: isRetryableProviderError,
        retryAfterMs: (error) => retryAfterMsOf(error),
        ...(this.hooks.sleep !== undefined ? { sleep: this.hooks.sleep } : {}),
        ...(this.hooks.random !== undefined ? { random: this.hooks.random } : {}),
      },
    );
    const parsed = this.parseChatResponse(body, model);
    const usage = normalizeUsage(parsed.usage, {
      inputText: joinMessages(input),
      outputText: parsed.content,
    });
    return {
      content: parsed.content,
      model: parsed.model,
      usage,
      // The gateway overlays cost from the provider's per-token rates.
      costCents: null,
      finishReason: parsed.finishReason,
      ...(parsed.toolCalls !== undefined ? { toolCalls: parsed.toolCalls } : {}),
    };
  }

  async *stream(input: ChatInput): AsyncIterable<ChatDelta> {
    const model = this.resolveModel(input);
    // IDLE TIMEOUT (RUN-FIX-21): the per-request timeout only guards the CONNECT, so a
    // model that stalls mid-stream — or "thinks" forever before the first token — would
    // hang `for await` indefinitely and FREEZE a streamed build. Race each pulled event
    // against an idle timer: if no delta arrives in `idleMs`, abort the connection.
    const idleMs = this.effectiveStreamIdleMs(input);
    // RETRY (RUN-FIX-21): if the stream stalls BEFORE the first token (the model never
    // starts — the dominant freeze the user hit), restart the whole call transparently.
    // This is the only stall we can safely retry: nothing has reached the consumer yet,
    // so there is no partial output to replay. Once a delta has been yielded a mid-stream
    // stall is terminal and surfaces as a timeout (the build then self-heals/errors,
    // never freezes). Caller cancellation is never retried.
    const maxRestarts = this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      // A stream-level abort so an idle stall (or a restart) can cancel the underlying
      // connection; composed with the caller's signal so cancellation still works.
      const streamAbort = new AbortController();
      const composedSignal =
        input.signal !== undefined
          ? AbortSignal.any([input.signal, streamAbort.signal])
          : streamAbort.signal;
      const streamInput: ChatInput = { ...input, signal: composedSignal };
      // Retry covers only the initial connect; the pre-first-token restart below covers
      // a connect that succeeds but then produces no tokens.
      const response = await withRetry(
        () => this.connectStream(this.buildStreamRequest(streamInput, model), streamInput),
        {
          maxRetries: this.maxRetries,
          isRetryable: isRetryableProviderError,
          retryAfterMs: (error) => retryAfterMsOf(error),
          ...(this.hooks.sleep !== undefined ? { sleep: this.hooks.sleep } : {}),
          ...(this.hooks.random !== undefined ? { random: this.hooks.random } : {}),
        },
      );

      const iterator = this.decodeStream(response, streamInput, model)[Symbol.asyncIterator]();
      let yieldedAny = false;
      let restart = false;
      try {
        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              streamAbort.abort();
              reject(timeoutError(idleMs));
            }, idleMs);
            timer.unref?.();
          });
          let result: IteratorResult<StreamEvent>;
          try {
            result = await Promise.race([iterator.next(), idle]);
          } catch (error) {
            // A pre-first-token idle stall, with restarts left and no caller cancel:
            // tear down this attempt and start the model call over.
            if (
              !yieldedAny &&
              attempt < maxRestarts &&
              input.signal?.aborted !== true &&
              isTimeoutError(error)
            ) {
              restart = true;
              break;
            }
            throw error;
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (result.done) {
            break;
          }
          const event = result.value;
          // Forward content chunks AND provider-reported usage (which previously was
          // dropped here, forcing the gateway to estimate), plus any tool-call fragments
          // / finish reason so a streamed turn can drive the tool loop. A usage- or
          // tool-only event still surfaces (empty content).
          if (
            event.content.length > 0 ||
            event.usage !== undefined ||
            event.toolCallDeltas !== undefined ||
            event.finishReason !== undefined
          ) {
            // Mark BEFORE yielding: once the consumer has seen a delta, a later stall is
            // terminal (we cannot replay it), so it must never trigger a restart.
            yieldedAny = true;
            yield {
              content: event.content,
              done: false,
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
              ...(event.toolCallDeltas !== undefined
                ? { toolCallDeltas: event.toolCallDeltas }
                : {}),
              ...(event.finishReason !== undefined ? { finishReason: event.finishReason } : {}),
            };
          }
        }
      } finally {
        // Release the underlying reader on every exit path (idle abort, restart, caller
        // cancel, a downstream throw). FIRE-AND-FORGET: streamAbort.abort() already
        // cancels the connection, and awaiting return() here would DEADLOCK on a
        // generator still suspended at a read the abort is tearing down.
        streamAbort.abort();
        void Promise.resolve(iterator.return?.()).catch(() => {});
      }
      if (restart) {
        // Small backoff between restarts (reuses the injected sleep seam when present).
        if (this.hooks.sleep !== undefined) await this.hooks.sleep(0);
        continue;
      }
      yield { content: '', done: true };
      return;
    }
  }

  // --- Internals ------------------------------------------------------------

  /** Sends a request under a composed timeout/abort signal and maps failures. */
  private async send(request: TransportRequest, input: ChatInput): Promise<TransportResponse> {
    const timeoutMs = this.effectiveTimeoutMs(input);
    const handle = withTimeout(timeoutMs, input.signal);
    try {
      return await this.transport.send({ ...request, signal: handle.signal });
    } catch (error) {
      throw this.mapSendError(error, handle.signal, input.signal, timeoutMs);
    } finally {
      handle.clear();
    }
  }

  /**
   * Connects a streaming request and verifies the HTTP status before any
   * deltas are produced, so a 429/500 on connect is retryable. The timeout
   * applies to the connect; once streaming begins it is the caller's signal
   * that governs cancellation.
   */
  private async connectStream(
    request: TransportRequest,
    input: ChatInput,
  ): Promise<TransportResponse> {
    const timeoutMs = this.effectiveTimeoutMs(input);
    const handle = withTimeout(timeoutMs, input.signal);
    // `finally` guarantees the timer/listener is released on every path —
    // including when reading the error body (`response.text()`) throws.
    try {
      let response: TransportResponse;
      try {
        response = await this.transport.send({ ...request, signal: handle.signal });
      } catch (error) {
        throw this.mapSendError(error, handle.signal, input.signal, timeoutMs);
      }
      if (!response.ok) {
        const body = await response.text();
        throw mapHttpError(response.status, body, response.headers);
      }
      return response;
    } finally {
      handle.clear();
    }
  }

  /** Translates a thrown transport error into a typed `ProviderError`. */
  private mapSendError(
    error: unknown,
    composedSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }
    const aborted = isAbortError(error) || composedSignal.aborted || callerSignal?.aborted === true;
    if (aborted) {
      if (isTimeoutAbort(composedSignal)) {
        return timeoutError(timeoutMs);
      }
      // Caller cancellation surfaces as a network_error so it is not retried as
      // a server fault but is still a typed ProviderError.
      return new ProviderError('Model provider request was aborted by the caller.', {
        code: 'network_error',
      });
    }
    return networkError(error);
  }
}

/** A single decoded streaming event: a content chunk and/or reported usage. */
export interface StreamEvent {
  content: string;
  usage?: Partial<ChatUsage>;
  /** Tool-call fragments decoded from this chunk (OpenAI-compatible streaming). */
  toolCallDeltas?: ToolCallDelta[];
  /** Provider finish reason, when this chunk reports it. */
  finishReason?: ChatFinishReason;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Pulls a `retry-after` (seconds) header off a mapped error's details, in ms. */
function retryAfterMsOf(error: unknown): number | null {
  if (!(error instanceof ProviderError)) {
    return null;
  }
  const details = error.details;
  if (details === undefined) {
    return null;
  }
  const retryAfter = details['retryAfterMs'];
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : null;
}

/** Joins all message contents for token estimation fallbacks. */
export function joinMessages(input: ChatInput): string {
  return input.messages.map((message) => message.content).join('\n');
}
