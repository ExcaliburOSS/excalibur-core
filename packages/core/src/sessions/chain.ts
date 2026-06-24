/**
 * AO8-1 — background CHAINING (reaction-on-completion). Splits a build request
 * into a PRIMARY task and an OPTIONAL follow-up to run automatically AFTER the
 * primary completes — so a `/bg` thread that finishes can trigger the next step
 * with no user command (the Excalibur analog of CC re-invoking the agent when a
 * background task completes).
 *
 * LLM-based + multilingual + NO regex (per the firm intent directive): the model
 * decides whether the request genuinely chains ("…and then…", "después…", "once
 * that's done…") in ANY language. Best-effort: any fault / skip yields the whole
 * request as the primary task with no follow-up, so `/bg` is unchanged.
 *
 * Core stays free of any model SDK — the call is injected (the REPL backs it with
 * the FAST model), mirroring `classifyTurnIntent`.
 */

import { firstJsonObject, oneLine } from './plan-shaping';
import type { IntentModel } from './intent-router';

/** A request split into a primary task + an optional auto-follow-up. */
export interface TaskChain {
  task: string;
  /** A task to auto-dispatch when `task` completes successfully, or null. */
  followUp: string | null;
}

/** Minimal gate context — chaining only applies to a real interactive, non-mock turn. */
export interface ChainContext {
  interactive: boolean;
  mock: boolean;
}

/** Builds the language-agnostic chain-split prompt (the MODEL handles any language). */
export function buildChainPrompt(request: string): string {
  return [
    'You split a build request into a PRIMARY task and an OPTIONAL follow-up that should run',
    'AFTER the primary completes. Read the request in ANY language; reply IN THE SAME LANGUAGE.',
    'Extract a follow-up ONLY when the request explicitly chains one (e.g. "and then", "after',
    'that", "once it is done", "después", "luego") — a single task has NO follow-up.',
    'Return ONLY this JSON (no prose, no markdown, no fences):',
    '{"task": string, "followUp": string | null}',
    'If there is no follow-up, set "followUp" to null and "task" to the whole request.',
    '',
    `Request: ${request}`,
  ].join('\n');
}

/** Parses + sanitizes the model answer into a {@link TaskChain} (best-effort). */
export function parseChainRequest(modelOutput: string, fallback: string): TaskChain {
  const obj = firstJsonObject(modelOutput);
  if (obj === null) return { task: fallback, followUp: null };
  const task =
    typeof obj['task'] === 'string' && obj['task'].trim().length > 0
      ? obj['task'].trim()
      : fallback;
  const rawFollow = obj['followUp'];
  const followUp =
    typeof rawFollow === 'string' && rawFollow.trim().length > 0 ? oneLine(rawFollow, 500) : null;
  // A follow-up identical to the task is not a real chain — drop it.
  return { task, followUp: followUp !== null && followUp !== task ? followUp : null };
}

/**
 * Splits a request into {@link TaskChain} via the injected model. Gated to a real
 * interactive, non-mock turn with a non-empty request; otherwise (and on any
 * fault) the whole request is the primary task with no follow-up. Never throws.
 */
export async function parseChain(
  request: string,
  ctx: ChainContext,
  classify: IntentModel,
  signal?: AbortSignal,
): Promise<TaskChain> {
  const trimmed = request.trim();
  if (ctx.mock || !ctx.interactive || trimmed.length === 0) {
    return { task: trimmed, followUp: null };
  }
  try {
    return parseChainRequest(await classify(buildChainPrompt(trimmed), signal), trimmed);
  } catch {
    return { task: trimmed, followUp: null };
  }
}

/** AO8-2 — what to do after a background task finishes. */
export type SupervisorAction = 'done' | 'continue' | 'escalate';

/** A supervisor's verdict on a completed background task. */
export interface SupervisorDecision {
  action: SupervisorAction;
  /** For `continue`: the follow-up task to run next. */
  followUp: string | null;
  /** For `continue`/`escalate`: one line to surface to the user. */
  note: string | null;
}

const SUPERVISOR_DONE: SupervisorDecision = { action: 'done', followUp: null, note: null };

/** The completed task's outcome, fed to the supervisor. */
export interface CompletionOutcome {
  task: string;
  outcome: 'done' | 'failed';
  /** The error message when it failed. */
  error?: string;
}

/** Builds the language-agnostic supervisor prompt (the MODEL handles any language). */
export function buildSupervisorPrompt(c: CompletionOutcome): string {
  return [
    'A background coding task just FINISHED. Decide the single next action. Be CONSERVATIVE:',
    'most finished tasks need NOTHING more — default to "done". Only:',
    '- "continue": there is an OBVIOUS, high-value next step (give it as a short "followUp" task);',
    '- "escalate": it failed or got stuck in a way that needs the USER (give a one-line "note");',
    '- "done": it is complete, or any next step is optional/unclear.',
    'Reply in the SAME LANGUAGE as the task. Return ONLY this JSON (no prose/markdown/fences):',
    '{"action": "done" | "continue" | "escalate", "followUp": string | null, "note": string | null}',
    '',
    `Task: ${c.task}`,
    `Outcome: ${c.outcome}${c.error !== undefined && c.error.length > 0 ? ` — ${c.error}` : ''}`,
  ].join('\n');
}

/** Parses + sanitizes the supervisor's answer (best-effort → `done`). */
export function parseSupervisorDecision(modelOutput: string): SupervisorDecision {
  const obj = firstJsonObject(modelOutput);
  if (obj === null) return SUPERVISOR_DONE;
  const action: SupervisorAction =
    obj['action'] === 'continue' || obj['action'] === 'escalate' ? obj['action'] : 'done';
  const followUpRaw = obj['followUp'];
  const followUp =
    typeof followUpRaw === 'string' && followUpRaw.trim().length > 0
      ? oneLine(followUpRaw, 500)
      : null;
  const noteRaw = obj['note'];
  const note =
    typeof noteRaw === 'string' && noteRaw.trim().length > 0 ? oneLine(noteRaw, 300) : null;
  // A `continue` with no follow-up task is not actionable → downgrade to `done`.
  if (action === 'continue' && followUp === null)
    return note !== null ? { action: 'done', followUp: null, note } : SUPERVISOR_DONE;
  return { action, followUp, note };
}

/**
 * Decides the next action after a background task finishes, via the injected
 * model. Gated to a real interactive, non-mock turn; otherwise (and on any fault)
 * `done`. Never throws. Whether a `continue` AUTO-dispatches vs is offered is the
 * caller's call (it knows the autonomy level).
 */
export async function superviseCompletion(
  c: CompletionOutcome,
  ctx: ChainContext,
  classify: IntentModel,
  signal?: AbortSignal,
): Promise<SupervisorDecision> {
  if (ctx.mock || !ctx.interactive || c.task.trim().length === 0) {
    return SUPERVISOR_DONE;
  }
  try {
    return parseSupervisorDecision(await classify(buildSupervisorPrompt(c), signal));
  } catch {
    return SUPERVISOR_DONE;
  }
}
