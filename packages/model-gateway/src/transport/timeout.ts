/**
 * Composes a per-request abort signal from a timeout timer plus an optional
 * caller-supplied signal, so the base provider can distinguish a *timeout*
 * abort from a *caller* abort and map each to the right `ProviderError`.
 */

/** Sentinel reason an aborted controller carries when the timeout fired. */
export const TIMEOUT_ABORT_REASON = Symbol('excalibur.provider.timeout');

/** True when `signal` was aborted by our timeout (vs a caller cancellation). */
export function isTimeoutAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === TIMEOUT_ABORT_REASON;
}

export interface TimeoutHandle {
  /** Signal to pass into the transport request. */
  signal: AbortSignal;
  /** Clears the timer and detaches the caller-signal listener. */
  clear(): void;
}

/**
 * Returns a composed signal that aborts when either the timer fires (after
 * `timeoutMs`, with `TIMEOUT_ABORT_REASON`) or the caller's signal aborts
 * (propagating the caller's reason). `clear()` must be called once the request
 * settles to release the timer/listener.
 */
export function withTimeout(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): TimeoutHandle {
  const controller = new AbortController();

  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason);
  };

  // If the caller already aborted, propagate immediately.
  if (callerSignal?.aborted === true) {
    controller.abort(callerSignal.reason);
  }

  const timer: ReturnType<typeof setTimeout> | null =
    timeoutMs > 0 && !controller.signal.aborted
      ? setTimeout(() => {
          controller.abort(TIMEOUT_ABORT_REASON);
        }, timeoutMs)
      : null;
  // Never keep the event loop alive solely for this timer.
  timer?.unref?.();

  if (callerSignal !== undefined && !callerSignal.aborted) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    clear(): void {
      if (timer !== null) {
        clearTimeout(timer);
      }
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}
