import type { ChatMessage } from '@excalibur/model-gateway';
import type { ExcaliburEvent } from '@excalibur/shared';
import { loadReplay, reconstructStateAt, type ReplayModel, type TokenTotals } from './replay';

/**
 * Time-machine fork-from-cache (T2) — the killer differentiator.
 *
 * Forking a run at step N replays the prefix (steps 0..N) FROM CACHE — not a
 * single token re-spent, not a line of good work redone — and runs only the
 * suffix live with the change you ask for (a new prompt, model or autonomy).
 * Two mechanisms combine:
 *
 *  1. the worktree state at N is reconstructed from the accumulated diff (the
 *     real files exist again), and
 *  2. the conversation up to N is reconstructed from the event log into a valid
 *     {@link ChatMessage} prefix that seeds the new agent loop.
 *
 * This module owns the PURE reconstruction (no I/O beyond loadReplay, no model
 * calls). The CLI orchestrates: materialize a worktree, create the forked run,
 * copy the prefix events (marked cached), then drive the loop with the seed.
 *
 * Correctness is critical: a malformed message prefix breaks real providers
 * (Anthropic requires every assistant tool_use to be answered by a tool_result
 * in the next turn). The reconstruction therefore pairs tool calls with their
 * results POSITIONALLY and TRUNCATES any dangling tool call when the cut point
 * lands mid-turn — the produced list is always self-consistent.
 */

/** The reconstructed plan for a fork (pure data; the CLI executes it). */
export interface ForkPlan {
  source: {
    runId: string;
    /** Zero-based step the fork branches at (clamped to the run's range). */
    atStep: number;
    totalSteps: number;
  };
  /**
   * The cached conversation prefix (system NOT included — the forked run builds
   * its own). Seed for `AgentRunInput.seedMessages`.
   */
  seedMessages: ChatMessage[];
  /** The accumulated diff to reconstruct the worktree at the fork point ('' if none). */
  baseDiff: string;
  /** Tokens the cached prefix represents (what forking SAVES vs re-running). */
  cachedTokens: TokenTotals;
  /** Cost in cents the cached prefix represents (null when no call carried a cost). */
  cachedCostCents: number | null;
  /** The source events 0..atStep (to copy into the fork's log, re-stamped). */
  prefixEvents: ExcaliburEvent[];
}

/** Reads a string payload field, or ''. */
function str(event: ExcaliburEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === 'string' ? value : '';
}

/** A `tool_call` event that ANNOUNCES a call (carries arguments, not a result). */
function isAnnouncement(event: ExcaliburEvent): boolean {
  return event.type === 'tool_call' && 'arguments' in event.payload;
}

/** Event types that carry a tool RESULT fed back to the model. */
const RESULT_TYPES: ReadonlySet<string> = new Set([
  'file_read',
  'file_write',
  'command_completed',
  'patch_applied',
  'branch_created',
]);

/** Whether an event is a tool result (paired with a preceding announcement). */
function isResult(event: ExcaliburEvent): boolean {
  if (RESULT_TYPES.has(event.type)) {
    return true;
  }
  // git_diff's result rides as a `tool_call` event carrying `result` (no args).
  if (event.type === 'tool_call' && !('arguments' in event.payload) && 'result' in event.payload) {
    return true;
  }
  // A declined mutation produced a `tool` message with the decline reason.
  if (
    event.type === 'policy_decision' &&
    event.payload['kind'] === 'confirmation' &&
    event.payload['decision'] === 'deny'
  ) {
    return true;
  }
  return false;
}

/** The textual tool result that was originally fed back to the model. */
function resultText(event: ExcaliburEvent): string {
  if (event.type === 'policy_decision') {
    return str(event, 'message') || 'user declined';
  }
  const result = str(event, 'result');
  if (result.length > 0) {
    return result;
  }
  return event.payload['ok'] === false ? 'failed' : 'ok';
}

/**
 * Reconstructs the cached conversation prefix (steps 0..atStep) as a VALID
 * {@link ChatMessage} list: the initial user task, then each model turn as an
 * assistant message (with its tool calls) followed by the paired tool results.
 * Dangling tool calls (when `atStep` cuts a turn before its results) are trimmed
 * so every assistant tool call is answered. The system message is NOT included.
 */
export function reconstructConversationPrefix(model: ReplayModel, atStep: number): ChatMessage[] {
  const upper = Math.min(Math.max(atStep, 0), model.steps.length - 1);
  const events = model.steps.slice(0, upper + 1).map((step) => step.event);

  const messages: ChatMessage[] = [{ role: 'user', content: model.run.title }];

  let turn = 0;
  let index = 0;
  while (index < events.length) {
    const event = events[index] as ExcaliburEvent;
    if (event.type !== 'model_call') {
      index += 1;
      continue;
    }

    const content = str(event, 'content');
    // Walk this turn's events IN ORDER (until the next model_call), pairing each
    // tool result with the oldest still-unanswered announcement — the order the
    // adapter actually ran them. This never mis-pairs a result to the wrong call
    // (which a zip of two separated announcement/result lists can), and a turn
    // truncated mid-execution simply leaves a trailing announcement unpaired.
    const pendingAnnouncements: ExcaliburEvent[] = [];
    const pairs: { announcement: ExcaliburEvent; result: ExcaliburEvent }[] = [];
    let cursor = index + 1;
    for (; cursor < events.length; cursor += 1) {
      const inner = events[cursor] as ExcaliburEvent;
      if (inner.type === 'model_call') {
        break;
      }
      if (isAnnouncement(inner)) {
        pendingAnnouncements.push(inner);
      } else if (isResult(inner)) {
        const announcement = pendingAnnouncements.shift();
        if (announcement !== undefined) {
          pairs.push({ announcement, result: inner });
        }
      }
      // assistant_message / patch_generated / phase_* are not paired tool I/O.
    }

    // Only complete (answered) pairs reach the prefix, so every assistant tool
    // call has a matching tool result — a dangling announcement is dropped.
    if (pairs.length > 0) {
      const toolCalls = pairs.map((pair, k) => ({
        id: `fork_${turn}_${k}`,
        name: str(pair.announcement, 'tool') || str(pair.announcement, 'name'),
        arguments:
          (pair.announcement.payload['arguments'] as Record<string, unknown> | undefined) ?? {},
      }));
      messages.push({ role: 'assistant', content, toolCalls });
      pairs.forEach((pair, k) => {
        messages.push({
          role: 'tool',
          toolCallId: `fork_${turn}_${k}`,
          content: resultText(pair.result),
        });
      });
    } else if (content.trim().length > 0) {
      // A plain assistant turn (final answer, or a truncated narration turn).
      messages.push({ role: 'assistant', content });
    }

    turn += 1;
    index = cursor;
  }

  return messages;
}

/**
 * Builds a {@link ForkPlan} for forking `runId` at step `atStep` (1-based step
 * numbers are the CLI's concern; this takes a 0-based index). Pure beyond
 * loading the run. Never throws on a sparse log (an empty run yields a plan with
 * just the task as the seed).
 */
export function planFork(repoRoot: string, runId: string, atStep: number): ForkPlan {
  const model = loadReplay(repoRoot, runId);
  const total = model.steps.length;
  const upper = total === 0 ? 0 : Math.min(Math.max(atStep, 0), total - 1);

  const state = total > 0 ? reconstructStateAt(model, upper) : null;
  const step = total > 0 ? model.steps[upper] : null;

  return {
    source: { runId, atStep: upper, totalSteps: total },
    seedMessages: total > 0 ? reconstructConversationPrefix(model, upper) : [],
    baseDiff: state?.accumulatedDiff ?? '',
    cachedTokens: step?.tokensSoFar ?? { input: 0, output: 0 },
    cachedCostCents: step?.costCentsSoFar ?? null,
    prefixEvents: total > 0 ? model.steps.slice(0, upper + 1).map((s) => s.event) : [],
  };
}

/**
 * Re-stamps prefix events for a forked run: the new run id, and a `cached` flag
 * + the source run id in the payload so the time-machine/Workbench can render
 * the replayed prefix distinctly from the live suffix. Pure.
 */
export function restampEventsForFork(events: ExcaliburEvent[], newRunId: string): ExcaliburEvent[] {
  return events.map((event, index) => ({
    ...event,
    // Fresh, fork-local event id so the replayed prefix NEVER collides with the
    // source run's `evt_<uuid>` ids — both logs can be ingested/deduped together
    // (e.g. Enterprise sync). Index-based so fork.ts stays pure + resume-cacheable.
    // The original timestamp is intentionally preserved: it records when the
    // cached work actually happened.
    id: `${newRunId}:fork:${index}`,
    runId: newRunId,
    payload: {
      ...event.payload,
      cached: true,
      replayedFromRunId: event.runId,
      replayedFromEventId: event.id,
    },
  }));
}

/** The reconstructed plan for an undo-to-checkpoint (pure data; CLI executes). */
export interface UndoPlan {
  runId: string;
  /** Zero-based step to revert the working tree to. */
  atStep: number;
  totalSteps: number;
  /** Accumulated diff at the checkpoint (the target state). */
  targetDiff: string;
  /** Accumulated diff at the end of the run (the changes to unwind). */
  fullDiff: string;
}

/**
 * Builds an {@link UndoPlan}: the diffs needed to revert the working tree to the
 * state at `atStep`. The CLI reverse-applies `fullDiff` then applies
 * `targetDiff`, each gated by a `git apply --check` pre-flight + confirmation,
 * so a diverged tree aborts safely rather than corrupting files.
 */
export function planUndo(repoRoot: string, runId: string, atStep: number): UndoPlan {
  const model = loadReplay(repoRoot, runId);
  const total = model.steps.length;
  const upper = total === 0 ? 0 : Math.min(Math.max(atStep, 0), total - 1);
  return {
    runId,
    atStep: upper,
    totalSteps: total,
    targetDiff: total > 0 ? reconstructStateAt(model, upper).accumulatedDiff : '',
    fullDiff: total > 0 ? reconstructStateAt(model, total - 1).accumulatedDiff : '',
  };
}
