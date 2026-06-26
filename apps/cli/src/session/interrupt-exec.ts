import type { InterruptOutcome } from '@excalibur/core';

/**
 * Executes a decided interruption (INT-1). The triage + routing is the pure
 * {@link InterruptOutcome} from core's `decideInterrupt`; this maps the chosen
 * {@link import('@excalibur/core').InterruptAction} onto the REPL's live-session
 * lifecycle through an injected {@link InterruptOps} — so the dispatch stays pure
 * and unit-testable while the REPL supplies the real abort/background/queue ops.
 *
 * The invariant the whole feature exists for: an interruption NEVER loses the
 * running work. `parallel` runs alongside it, `pause_switch` resumes-by-re-queue,
 * `fold` runs right after, and a side-question keeps the run going — only an
 * explicit `stop` aborts.
 */
export interface InterruptOps {
  /** Show the instant acknowledgment line in the live rail (before acting). */
  say(text: string): void;
  /** Abort the in-flight foreground turn (an explicit stop, or before a switch). */
  abort(): void;
  /** Run the text as an INDEPENDENT background thread (new + non-conflicting work). */
  runParallel(text: string): void;
  /**
   * Queue text to run as the NEXT foreground turn. `abortCurrent` ends the
   * running turn first (pause + switch); otherwise it runs after the current one
   * finishes (a folded steer). `reaskAfter`, when set, is the pending question to
   * re-issue once the queued work is done — so a question is never lost.
   */
  queueForeground(text: string, opts: { abortCurrent: boolean; reaskAfter?: string }): void;
  /**
   * Record a conversational message into the session so the model sees it on the
   * next turn (a quick aside that should not derail the run, or the answer to a
   * question the run is blocked on).
   */
  recordMessage(text: string): void;
}

/**
 * Routes a decided interrupt to the session ops. Always shows the ack first, then
 * acts. `pendingQuestion` is the prompt Excalibur was awaiting (so a re-ask can
 * restore it); only consulted when the plan asks to re-ask. Pure dispatch.
 */
export function executeInterrupt(
  outcome: InterruptOutcome,
  original: string,
  ops: InterruptOps,
  pendingQuestion?: string,
): void {
  ops.say(outcome.plan.ack);
  const reask =
    outcome.plan.reaskAfter && pendingQuestion !== undefined && pendingQuestion.length > 0
      ? pendingQuestion
      : undefined;
  switch (outcome.plan.action) {
    case 'abort':
      ops.abort();
      break;
    case 'parallel':
      ops.runParallel(original);
      break;
    case 'pause_switch':
      ops.queueForeground(original, {
        abortCurrent: true,
        ...(reask !== undefined ? { reaskAfter: reask } : {}),
      });
      break;
    case 'fold':
      ops.queueForeground(original, {
        abortCurrent: false,
        ...(reask !== undefined ? { reaskAfter: reask } : {}),
      });
      break;
    case 'answer_inline':
      // A quick aside: keep the run going, just record it (answered next turn). If
      // the run was blocked awaiting an answer, the pending question stays live —
      // re-queue it so it is asked again after this aside.
      ops.recordMessage(original);
      if (reask !== undefined) {
        ops.queueForeground(reask, { abortCurrent: false });
      }
      break;
    case 'feed_answer':
      // The input IS the answer to what the run asked — record it so the loop
      // (and the next turn) consume it.
      ops.recordMessage(original);
      break;
  }
}
