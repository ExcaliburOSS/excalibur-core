/**
 * Exponential backoff with full jitter, used for `chat()` and the initial
 * connect of `stream()` (never mid-stream — see base-http-provider).
 *
 * `sleep` and `random` are injectable so tests run instantly and
 * deterministically (combine with `vi.useFakeTimers()`).
 */

export interface RetryOptions<E = unknown> {
  /** Number of retries after the first attempt. Default 2 (so 3 attempts max). */
  maxRetries?: number;
  /** Base backoff in ms. Default 500. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 8000. */
  maxDelayMs?: number;
  /** Whether a thrown error is worth retrying. */
  isRetryable(error: E): boolean;
  /** Server-suggested delay (e.g. from a `Retry-After` header), in ms, or null. */
  retryAfterMs?(error: E): number | null;
  /** Injected sleep (default real `setTimeout`). */
  sleep?(ms: number): Promise<void>;
  /** Injected RNG in [0, 1) for jitter (default `Math.random`). */
  random?(): number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying retryable failures with exponential backoff and full
 * jitter: `delay = random() * min(maxDelayMs, baseDelayMs * 2^attempt)`. A
 * server-supplied `retryAfterMs` (capped at `maxDelayMs`) overrides the
 * computed delay when present. The last error is re-thrown once retries are
 * exhausted or the error is non-retryable.
 */
export async function withRetry<T, E = unknown>(
  fn: () => Promise<T>,
  opts: RetryOptions<E>,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const typed = error as E;
      if (attempt >= maxRetries || !opts.isRetryable(typed)) {
        throw error;
      }
      const suggested = opts.retryAfterMs?.(typed) ?? null;
      let delay: number;
      if (suggested !== null && suggested >= 0) {
        delay = Math.min(suggested, maxDelayMs);
      } else {
        const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        delay = random() * ceiling;
      }
      await sleep(delay);
      attempt += 1;
    }
  }
}
