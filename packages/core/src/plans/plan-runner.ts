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

/**
 * G1 (Phase-G) — does the work for a whole BATCH of mutually-independent steps AT
 * ONCE (the caller fans them out to a parallel swarm, each lane in its own
 * worktree, verified + merged). Invoked instead of the per-step {@link
 * PlanStepExecutor} only when a phase's entire not-done set is mutually
 * independent (see the fan-out gate below) — so the phase becomes one parallel
 * wave and its boundary is the swarm's own verify gate. Returns a per-step-id
 * verdict; a step with no entry is treated as `blocked` (safe, resumable). The
 * plan runner still owns dependency ordering, skip-on-done (resume), abort, and
 * the `onStep` checkpoint — this only changes HOW an independent phase runs.
 */
export type PlanPhaseExecutor = (
  steps: PlanStep[],
  ctx: { plan: StructuredPlan; phase: PlanPhase; signal?: AbortSignal },
) => Promise<Map<string, PlanStepResult>>;

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
  /**
   * G1 — when provided, a phase whose ENTIRE not-done set is mutually independent
   * (≥2 steps, every dep already `done`) is run as ONE batch through this executor
   * (a parallel swarm) instead of step-by-step. Absent → always sequential (the
   * caller omits it when the repo can't host worktrees, the model is a mock, or
   * autonomy is too low to auto-merge). Never changes ordering, resume, or
   * checkpointing — only how an independent phase is executed.
   */
  phaseExecutor?: PlanPhaseExecutor;
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
  const { signal, onStep, continueOnBlock = false, phaseExecutor } = options;
  const blockedStepIds: string[] = [];
  let ranSteps = 0;
  let stopped = false;

  const isDone = (id: string): boolean => findStep(plan, id)?.step.status === 'done';
  // A function (not an inline expression) so TS doesn't keep the prior check's
  // narrowing across the `await` — `AbortSignal.aborted` is `readonly`, so an
  // inline `signal?.aborted === true` would be seen as unchanging.
  const isAborted = (): boolean => signal?.aborted === true;
  const signalCtx = signal !== undefined ? { signal } : {};

  for (const phase of plan.phases) {
    if (stopped) break;

    // G1 — parallel phase fan-out. When a phaseExecutor is wired AND the phase's
    // entire not-done set is mutually independent (≥2 steps, and every dep is
    // already `done`), run the whole phase as ONE parallel batch. The dep check
    // `deps.every(isDone)` captures BOTH satisfied cross-phase deps AND the
    // absence of any intra-phase dependency (a not-done sibling isn't `done`, so a
    // step depending on it fails this test) — so the whole not-done set really is
    // one safe wave. Any other shape (a single step, or intra-phase ordering)
    // falls through to the unchanged sequential loop below.
    if (phaseExecutor !== undefined) {
      const notDone = phase.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped');
      const independent = notDone.length >= 2 && notDone.every((s) => (s.deps ?? []).every(isDone));
      if (independent) {
        if (isAborted()) break;
        for (const step of notDone) {
          step.status = 'active';
          onStep?.(step, phase);
        }
        let results: Map<string, PlanStepResult>;
        try {
          results = await phaseExecutor(notDone, { plan, phase, ...signalCtx });
        } catch {
          results = new Map(notDone.map((s) => [s.id, { status: 'blocked' as const }]));
        }
        let anyBlocked = false;
        for (const step of notDone) {
          const r = results.get(step.id) ?? { status: 'blocked' as const };
          step.status = r.status;
          if (r.runId !== undefined) {
            step.runId = r.runId;
          }
          onStep?.(step, phase);
          ranSteps += 1;
          if (r.status === 'blocked') {
            blockedStepIds.push(step.id);
            anyBlocked = true;
          }
        }
        if (anyBlocked && !continueOnBlock) {
          stopped = true;
          break;
        }
        if (isAborted()) {
          stopped = true;
          break;
        }
        continue; // the whole phase ran as one batch — skip the per-step loop
      }
    }

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
