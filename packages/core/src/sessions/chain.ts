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
