/**
 * HTTP → `ProviderError` mapping for the real provider adapters (OSS-4, M2).
 *
 * Every error body is run through `redactSecrets` before any snippet is placed
 * in `ProviderError.details`, so an echoed API key never lands in a log or
 * artifact. Error codes are exported as constants so callers (the CLI
 * fallback, retry logic) can branch on them without string literals.
 */

import { ProviderError } from '@excalibur/shared';
import { redactSecrets } from '../redaction/redaction';

export const PROVIDER_ERROR_CODES = {
  invalidRequest: 'invalid_request',
  authFailed: 'auth_failed',
  modelNotFound: 'model_not_found',
  rateLimited: 'rate_limited',
  serverError: 'server_error',
  timeout: 'timeout',
  networkError: 'network_error',
} as const;

export type ProviderErrorCode =
  (typeof PROVIDER_ERROR_CODES)[keyof typeof PROVIDER_ERROR_CODES];

/** Error codes whose failures are safe to retry (transient / server-side). */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<string>([
  PROVIDER_ERROR_CODES.rateLimited,
  PROVIDER_ERROR_CODES.serverError,
  PROVIDER_ERROR_CODES.timeout,
  PROVIDER_ERROR_CODES.networkError,
]);

/** Max length of the (redacted) response-body snippet stored in `details`. */
const MAX_BODY_SNIPPET = 500;

function bodySnippet(body: string): string {
  const redacted = redactSecrets(body);
  return redacted.length > MAX_BODY_SNIPPET
    ? `${redacted.slice(0, MAX_BODY_SNIPPET)}…`
    : redacted;
}

interface ErrorMapping {
  code: ProviderErrorCode;
  message: string;
}

function mapStatus(status: number): ErrorMapping {
  if (status === 400) {
    return { code: PROVIDER_ERROR_CODES.invalidRequest, message: 'Invalid request (HTTP 400)' };
  }
  if (status === 401 || status === 403) {
    return {
      code: PROVIDER_ERROR_CODES.authFailed,
      message: `Authentication failed (HTTP ${status}). Check the configured API key environment variable.`,
    };
  }
  if (status === 404) {
    return {
      code: PROVIDER_ERROR_CODES.modelNotFound,
      message: 'Model or endpoint not found (HTTP 404)',
    };
  }
  if (status === 429) {
    return { code: PROVIDER_ERROR_CODES.rateLimited, message: 'Rate limited (HTTP 429)' };
  }
  if (status >= 500) {
    return {
      code: PROVIDER_ERROR_CODES.serverError,
      message: `Upstream server error (HTTP ${status})`,
    };
  }
  // Any other non-2xx — treat as an invalid request the caller must inspect.
  return {
    code: PROVIDER_ERROR_CODES.invalidRequest,
    message: `Unexpected provider response (HTTP ${status})`,
  };
}

/**
 * Parses an HTTP `Retry-After` header into milliseconds. Supports the
 * delta-seconds form (`"30"`); an HTTP-date form returns null (the backoff
 * falls through to jittered exponential delay).
 */
export function parseRetryAfterMs(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  return null;
}

/**
 * Maps a non-2xx HTTP response to a `ProviderError`. The (redacted) body
 * snippet is attached to `details.body`; `details.status` carries the status.
 * A parsed `Retry-After` (from `headers`) is attached as `details.retryAfterMs`
 * so the backoff can honor a server-suggested delay.
 */
export function mapHttpError(
  status: number,
  body: string,
  headers?: Record<string, string>,
): ProviderError {
  const { code, message } = mapStatus(status);
  const details: Record<string, unknown> = { status, body: bodySnippet(body) };
  const retryAfterMs = parseRetryAfterMs(headers?.['retry-after']);
  if (retryAfterMs !== null) {
    details['retryAfterMs'] = retryAfterMs;
  }
  return new ProviderError(message, { code, details });
}

/** A timeout `ProviderError` (retryable). */
export function timeoutError(timeoutMs: number): ProviderError {
  return new ProviderError(`Request to model provider timed out after ${timeoutMs}ms.`, {
    code: PROVIDER_ERROR_CODES.timeout,
    details: { timeoutMs },
  });
}

/** A network-failure `ProviderError` (retryable). The cause message is redacted. */
export function networkError(cause: unknown): ProviderError {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new ProviderError(`Network error contacting model provider: ${redactSecrets(reason)}`, {
    code: PROVIDER_ERROR_CODES.networkError,
  });
}

/** True for `ProviderError`s whose code is in the retryable set. */
export function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ProviderError && RETRYABLE_CODES.has(error.code);
}

/**
 * A non-retryable `ProviderError` for a tool call whose arguments could not be
 * parsed into a JSON object. Surfaced (rather than crashing) so the agent loop
 * can decide how to recover. The `reason` is redacted and the tool name and
 * (truncated, redacted) raw argument string are attached for diagnostics.
 */
export function toolArgumentsError(
  toolName: string,
  rawArguments: string,
  reason: unknown,
): ProviderError {
  const why = reason instanceof Error ? reason.message : String(reason);
  return new ProviderError(
    `Model returned malformed JSON arguments for tool "${toolName}".`,
    {
      code: PROVIDER_ERROR_CODES.invalidRequest,
      details: {
        tool: toolName,
        reason: redactSecrets(why),
        arguments: bodySnippet(rawArguments),
      },
    },
  );
}

/**
 * Normalizes a model's tool-call arguments into a parsed object. Tolerates the
 * two wire forms providers emit:
 *   - a JSON string (OpenAI / Anthropic) → `JSON.parse`d;
 *   - an already-parsed object (Ollama, or a provider that pre-parses).
 * An empty/whitespace string means "no arguments" → `{}`. A non-object JSON
 * value (string, number, array, null) or invalid JSON throws a typed
 * {@link toolArgumentsError} so the malformed call never reaches the loop.
 */
export function parseToolArguments(
  toolName: string,
  raw: unknown,
): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw === 'object') {
    // Arrays are not a valid arguments object.
    if (Array.isArray(raw)) {
      throw toolArgumentsError(toolName, JSON.stringify(raw), 'arguments must be a JSON object');
    }
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== 'string') {
    throw toolArgumentsError(toolName, String(raw), 'arguments must be a JSON object or string');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw toolArgumentsError(toolName, raw, error);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw toolArgumentsError(toolName, raw, 'arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
