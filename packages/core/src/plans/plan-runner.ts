/**
 * The RESUMABLE plan runner (PLAN3) — drives a {@link StructuredPlan} step by step,
 * marking each step active → done (or blocked on failure) so the structured sidecar
 * is a durable checkpoint. RESUME falls out for free: a step already `done`/`skipped`
 * is skipped, so re-running a partially-finished plan continues at the first
 * unfinished step — close the shell, come back days later, pick up at exactly step N.
 *
 * Pure orchestration: the caller supplies an {@link PlanStepExecutor} that actually
 * does the work (an implementer pass) and an `onStep` sink that persists each status
 * change (e.g. `updatePlanStep`). Dependency-aware (a step whose deps aren't done is
 * blocked), abortable (stops cleanly on the signal), and never throws — an executor
 * that throws marks its step `blocked`.
 */

import {
  findStep,
  nextPendingStep,
  type PlanPhase,
  type PlanStep,
  type StructuredPlan,
} from './plan-model';

/** The outcome an executor reports for one step. */
export interface PlanStepResult {
  status: 'done' | 'blocked';
  /** The run that did the work, recorded on the step for traceability/resume. */
  runId?: string;
}

/** Does the actual work for one step. Should honour `ctx.signal` and resolve quickly on abort. */
export type PlanStepExecutor = (
  step: PlanStep,
  ctx: { plan: StructuredPlan; phase: PlanPhase; signal?: AbortSignal },
) => Promise<PlanStepResult>;

export interface RunStructuredPlanOptions {
  signal?: AbortSignal;
  /**
   * Called AFTER each status change (active, then done/blocked) — the caller persists
   * it (e.g. `updatePlanStep(repo, id, step.id, step.status, step.runId)`), so an
   * interrupted run leaves a durable, resumable checkpoint on disk.
   */
  onStep?: (step: PlanStep, phase: PlanPhase) => void;
  /** Keep going after a step blocks (default: stop — a failure usually cascades). */
  continueOnBlock?: boolean;
}

export interface RunStructuredPlanResult {
  /** The same plan object, mutated in place with the new step statuses. */
  plan: StructuredPlan;
  /** True when every step is `done` or `skipped`. */
  completed: boolean;
  /** How many steps the executor actually ran this call (skipped ones don't count). */
  ranSteps: number;
  /** The next unfinished step when the run stopped early (abort/block), else null. */
  stoppedAtStepId: string | null;
  /** Steps that blocked this call (executor failure or unmet deps). */
  blockedStepIds: string[];
}

/**
 * Drives the plan in phase/step order. Already-done/skipped steps are passed over
 * (this is what makes a re-run a RESUME). Returns once the plan completes, the signal
 * aborts, or a step blocks (unless `continueOnBlock`).
 */
export async function runStructuredPlan(
  plan: StructuredPlan,
  executor: PlanStepExecutor,
  options: RunStructuredPlanOptions = {},
): Promise<RunStructuredPlanResult> {
  const { signal, onStep, continueOnBlock = false } = options;
  const blockedStepIds: string[] = [];
  let ranSteps = 0;
  let stopped = false;

  const isDone = (id: string): boolean => findStep(plan, id)?.step.status === 'done';
  // A function (not an inline expression) so TS doesn't keep the prior check's
  // narrowing across the `await` — `AbortSignal.aborted` is `readonly`, so an
  // inline `signal?.aborted === true` would be seen as unchanging.
  const isAborted = (): boolean => signal?.aborted === true;

  for (const phase of plan.phases) {
    if (stopped) break;
    for (const step of phase.steps) {
      if (isAborted()) {
        stopped = true;
        break;
      }
      if (step.status === 'done' || step.status === 'skipped') {
        continue; // RESUME: this step is already settled — skip it.
      }

      // Gate on dependencies — a step whose deps aren't all done can't run yet.
      const unmet = (step.deps ?? []).filter((dep) => !isDone(dep));
      if (unmet.length > 0) {
        step.status = 'blocked';
        onStep?.(step, phase);
        blockedStepIds.push(step.id);
        if (!continueOnBlock) {
          stopped = true;
          break;
        }
        continue;
      }

      step.status = 'active';
      onStep?.(step, phase);

      let result: PlanStepResult;
      try {
        result = await executor(step, { plan, phase, ...(signal !== undefined ? { signal } : {}) });
      } catch {
        result = { status: 'blocked' };
      }
      step.status = result.status;
      if (result.runId !== undefined) {
        step.runId = result.runId;
      }
      onStep?.(step, phase);
      ranSteps += 1;

      if (result.status === 'blocked') {
        blockedStepIds.push(step.id);
        if (!continueOnBlock) {
          stopped = true;
          break;
        }
      }
      if (isAborted()) {
        stopped = true;
        break;
      }
    }
  }

  const completed = plan.phases.every((phase) =>
    phase.steps.every((step) => step.status === 'done' || step.status === 'skipped'),
  );
  return {
    plan,
    completed,
    ranSteps,
    stoppedAtStepId: completed ? null : (nextPendingStep(plan)?.step.id ?? null),
    blockedStepIds,
  };
}
