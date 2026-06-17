import type { ChatMessage, ModelGateway } from '@excalibur/model-gateway';
import { runAgentTurn, type AgentTurnDeps, type AgentTurnResult } from './agent-turn';

/**
 * Autonomous goal loop (`/goal`) — the audit's #1 build. Pursues an objective
 * ACROSS turns until an independent EVALUATOR confirms it is achieved, instead of
 * a single one-shot turn. Each iteration is an ordinary {@link runAgentTurn} —
 * so it is gated by the session's autonomy + permission engine, ESC-cancellable,
 * and produces its own replayable/forkable run (events.jsonl). The evaluator is a
 * cheap-model judge (routed to the `cheap` provider) so verification is fast and
 * cheap; a hard `maxIterations` bound is the anti-runaway backstop.
 */

export interface GoalVerdict {
  done: boolean;
  reason: string;
}

/**
 * Result of a {@link GoalLoopOptions.deterministicCheck} — an objective,
 * ground-truth signal (e.g. "tests are green") that does not depend on a model's
 * judgement.
 */
export interface DeterministicCheckResult {
  /** `true` iff the goal's objective acceptance criterion is met. */
  passed: boolean;
  /** Human-readable detail: the proof when passed, or what failed otherwise. */
  detail: string;
}

export type GoalLoopStatus = 'done' | 'max-iterations' | 'aborted' | 'evaluator-failed';

export interface GoalLoopResult {
  status: GoalLoopStatus;
  iterations: number;
  results: AgentTurnResult[];
  finalText: string;
  lastReason: string;
}

export interface GoalLoopOptions {
  /** Hard cap on iterations (anti-runaway). */
  maxIterations: number;
  signal?: AbortSignal;
  /** Prior conversation seed (cross-turn memory) for the first iteration. */
  seed?: ChatMessage[];
  /** Provider to route the model judge to (typically the `cheap`/fast model). */
  evaluatorProvider?: string;
  /** Evaluator override (tests inject a deterministic judge). */
  evaluate?: (goal: string, latest: string) => Promise<GoalVerdict>;
  /**
   * Optional objective acceptance check run after each agent turn (e.g. "the
   * project's tests pass"). When supplied it is AUTHORITATIVE: a `passed` result
   * ends the loop as `done` immediately — no model judge is consulted — and a
   * failing result's `detail` drives the next iteration's reviewer feedback. When
   * omitted, the loop falls back to the model-judge path unchanged.
   */
  deterministicCheck?: () => Promise<DeterministicCheckResult>;
  /** Progress callback after each iteration's verdict. */
  onIteration?: (iteration: number, verdict: GoalVerdict) => void;
}

const VERDICT_SYSTEM =
  'You are a strict reviewer judging whether a coding GOAL has been FULLY achieved, ' +
  "based only on the agent's latest report. Reply with ONLY compact JSON: " +
  '{"done": boolean, "reason": "<one short sentence>"}. Be conservative — set done=true ' +
  'only when the goal is clearly and completely met; otherwise done=false with what remains.';

/**
 * Parses an evaluator reply into a verdict. Tolerant of prose around the JSON;
 * CONSERVATIVE on failure (`done:false`) so a malformed judge reply never falsely
 * ends the loop.
 */
export function parseVerdict(text: string): GoalVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (match !== null) {
    try {
      const parsed = JSON.parse(match[0]) as { done?: unknown; reason?: unknown };
      return {
        done: parsed.done === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      };
    } catch {
      /* fall through to conservative default */
    }
  }
  return { done: false, reason: '(could not parse the evaluator response)' };
}

/** The default evaluator: a cheap-model judge over the agent's latest report. */
async function evaluateWithModel(
  gateway: ModelGateway,
  goal: string,
  latest: string,
  provider: string | undefined,
  signal: AbortSignal | undefined,
): Promise<GoalVerdict> {
  const output = await gateway.chat({
    ...(provider !== undefined ? { provider } : {}),
    messages: [
      { role: 'system', content: VERDICT_SYSTEM },
      {
        role: 'user',
        content: `GOAL:\n${goal}\n\nAGENT'S LATEST REPORT:\n${latest}\n\nIs the goal fully achieved?`,
      },
    ],
    maxTokens: 160,
    // No `temperature` — reasoning models (e.g. kimi-k2.7-code) reject it with
    // HTTP 400; omitting it keeps the evaluator provider-agnostic.
    ...(signal !== undefined ? { signal } : {}),
    metadata: { kind: 'goal-eval' },
  });
  return parseVerdict(output.content);
}

/**
 * Runs the goal loop: iterate an agent turn → evaluate → continue with the
 * reviewer's feedback until `done`, the `maxIterations` cap, an abort, or an
 * evaluator failure. The repository (and prior iterations' edits) are the carried
 * state across iterations; the feedback steers the next pass.
 *
 * When {@link GoalLoopOptions.deterministicCheck} is supplied it takes precedence
 * over the model judge: a `passed` check short-circuits to `done` (its `detail`
 * becomes the reason and no model is called), while a failing check drives the
 * next iteration's feedback with its `detail`. Without it, behavior is the
 * model-judge path unchanged.
 */
export async function runGoalLoop(
  turn: AgentTurnDeps,
  goal: string,
  options: GoalLoopOptions,
): Promise<GoalLoopResult> {
  const results: AgentTurnResult[] = [];
  let prompt = goal;
  let lastReason = '';
  const aborted = (): boolean => options.signal?.aborted === true;

  for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
    if (aborted()) {
      return {
        status: 'aborted',
        iterations: iteration - 1,
        results,
        finalText: results.at(-1)?.text ?? '',
        lastReason,
      };
    }

    // The first iteration carries the prior-conversation seed; later iterations
    // rely on the repo state + the reviewer feedback embedded in `prompt`.
    const result = await runAgentTurn(turn, prompt, iteration === 1 ? options.seed : undefined);
    results.push(result);

    if (aborted()) {
      return {
        status: 'aborted',
        iterations: iteration,
        results,
        finalText: result.text,
        lastReason,
      };
    }

    // Authoritative objective check (if any): a pass is ground-truth DONE and
    // short-circuits the model judge; a failure both supersedes the next prompt's
    // feedback and is reported via `onIteration` without ending the loop.
    let deterministic: DeterministicCheckResult | undefined;
    if (options.deterministicCheck !== undefined) {
      try {
        deterministic = await options.deterministicCheck();
      } catch {
        return {
          status: 'evaluator-failed',
          iterations: iteration,
          results,
          finalText: result.text,
          lastReason,
        };
      }
      if (deterministic.passed) {
        lastReason = deterministic.detail;
        const verdict: GoalVerdict = { done: true, reason: deterministic.detail };
        options.onIteration?.(iteration, verdict);
        return {
          status: 'done',
          iterations: iteration,
          results,
          finalText: result.text,
          lastReason,
        };
      }
    }

    let verdict: GoalVerdict;
    try {
      verdict =
        options.evaluate !== undefined
          ? await options.evaluate(goal, result.text)
          : await evaluateWithModel(
              turn.gateway,
              goal,
              result.text,
              options.evaluatorProvider,
              options.signal,
            );
    } catch {
      return {
        status: 'evaluator-failed',
        iterations: iteration,
        results,
        finalText: result.text,
        lastReason,
      };
    }

    // A failing deterministic check overrides any model "done": ground truth says
    // the goal is NOT met, and its detail drives the next iteration's feedback.
    if (deterministic !== undefined) {
      verdict = { done: false, reason: deterministic.detail };
    }

    lastReason = verdict.reason;
    options.onIteration?.(iteration, verdict);
    if (verdict.done) {
      return { status: 'done', iterations: iteration, results, finalText: result.text, lastReason };
    }
    prompt =
      `The goal is NOT yet complete. Reviewer feedback: ${verdict.reason}\n\n` +
      `Continue working toward this goal:\n${goal}`;
  }

  return {
    status: 'max-iterations',
    iterations: options.maxIterations,
    results,
    finalText: results.at(-1)?.text ?? '',
    lastReason,
  };
}
