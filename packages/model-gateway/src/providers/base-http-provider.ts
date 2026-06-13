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
  mapHttpError,
  networkError,
  timeoutError,
} from '../errors/provider-errors';
import { normalizeUsage } from '../cost/token-accounting';
import { withRetry } from '../transport/retry';
import { isTimeoutAbort, withTimeout } from '../transport/timeout';
import type {
  HttpTransport,
  TransportRequest,
  TransportResponse,
} from '../transport/transport';
import type {
  ChatDelta,
  ChatFinishReason,
  ChatInput,
  ChatOutput,
  ChatUsage,
  ModelProviderAdapter,
} from '../types';
import type { ProviderConfig } from './providers-file';
import { resolveApiKey } from './providers-file';

/** Default timeout and retry budget when the provider config omits them. */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

/** Parsed result of a non-streaming chat response. */
export interface ParsedChatResponse {
  content: string;
  usage: Partial<ChatUsage>;
  finishReason: ChatFinishReason;
  model: string;
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
    return input.timeoutMs !== undefined && input.timeoutMs > 0
      ? input.timeoutMs
      : this.timeoutMs;
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
    };
  }

  async *stream(input: ChatInput): AsyncIterable<ChatDelta> {
    const model = this.resolveModel(input);
    // Retry covers only the initial connect; never mid-stream.
    const response = await withRetry(
      () => this.connectStream(this.buildStreamRequest(input, model), input),
      {
        maxRetries: this.maxRetries,
        isRetryable: isRetryableProviderError,
        retryAfterMs: (error) => retryAfterMsOf(error),
        ...(this.hooks.sleep !== undefined ? { sleep: this.hooks.sleep } : {}),
        ...(this.hooks.random !== undefined ? { random: this.hooks.random } : {}),
      },
    );

    for await (const event of this.decodeStream(response, input, model)) {
      if (event.content.length > 0) {
        yield { content: event.content, done: false };
      }
    }
    yield { content: '', done: true };
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
    const aborted =
      isAbortError(error) || composedSignal.aborted || callerSignal?.aborted === true;
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
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
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
