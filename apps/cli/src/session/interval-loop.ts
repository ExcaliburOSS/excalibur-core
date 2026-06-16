/**
 * Interval loop (`/loop`) — RECURRENCE, not completion. Re-runs a step on a
 * fixed interval up to a cap, until ESC. Distinct from the goal loop (`/goal`),
 * which stops when an evaluator says the objective is DONE: `/loop` stops on
 * time/count/cancel. Use it to watch/poll/retry periodically (e.g. re-run a
 * check every N seconds). Each iteration is whatever `run` does — typically a
 * gated agent turn.
 */

export type IntervalLoopStatus = 'completed' | 'aborted';

export interface IntervalLoopResult {
  status: IntervalLoopStatus;
  iterations: number;
}

export interface IntervalLoopOptions {
  /** Seconds to wait between iterations (0 = back-to-back). */
  everySeconds: number;
  /** Hard cap on iterations. */
  times: number;
  signal?: AbortSignal;
  /** Runs one iteration (1-based). */
  run: (iteration: number) => Promise<void>;
  /** Delay impl (injectable for tests); defaults to {@link abortableSleep}. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A `setTimeout` delay that resolves early when the signal aborts. Unref'd. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `run` once per iteration up to `times`, sleeping `everySeconds` between
 * (interruptibly). Stops early — `status: 'aborted'` — the moment the signal
 * aborts (before/after an iteration or during the wait).
 */
export async function runIntervalLoop(options: IntervalLoopOptions): Promise<IntervalLoopResult> {
  const sleep = options.sleep ?? abortableSleep;
  const aborted = (): boolean => options.signal?.aborted === true;

  for (let iteration = 1; iteration <= options.times; iteration += 1) {
    if (aborted()) {
      return { status: 'aborted', iterations: iteration - 1 };
    }
    await options.run(iteration);
    if (aborted()) {
      return { status: 'aborted', iterations: iteration };
    }
    if (iteration < options.times && options.everySeconds > 0) {
      await sleep(options.everySeconds * 1000, options.signal);
      if (aborted()) {
        return { status: 'aborted', iterations: iteration };
      }
    }
  }
  return { status: 'completed', iterations: options.times };
}
