import { topologicalWaves } from '../swarm/toposort';
import type { CapabilityKind, Mission, OrchestrationPlan, PlanStep } from './types';

/**
 * M4 — the MissionSupervisor: the ADAPTIVE executor that drives a capability DAG
 * (the auto-authored {@link OrchestrationPlan}) to completion, re-assessing after
 * each meaningful step. This is what makes the meta-orchestrator beat a static
 * todo list: it doesn't just walk the plan, it watches what happens and adapts —
 * retries, escalates a single agent to a swarm, splices in new steps, or stops.
 *
 * The supervisor is engine-agnostic: it calls an INJECTED {@link CapabilityExecutor}
 * to actually run each capability (the CLI wires real engines — understand→a
 * read-only run, implement→executeLocalRun, parallelize→runSwarm, …), and an
 * optional {@link Reassessor} (the model) for the adaptive decisions. Pure control
 * flow here, so it is fully unit-testable with fakes. Never throws.
 */

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** The outcome of running one capability step. */
export interface StepResult {
  ok: boolean;
  /** What happened — fed into reassessment, later steps, and the narration. */
  summary: string;
  /** Optional structured signals (e.g. `{ filesChanged: 3, testsPassed: false }`). */
  signals?: Record<string, unknown>;
}

export interface StepState {
  step: PlanStep;
  status: StepStatus;
  /** How many times this step has been run (retry/escalate bounded by maxAttempts). */
  attempts: number;
  result?: StepResult;
}

/** `paused` is resumable (budget/time ceiling hit), distinct from the terminals. */
export type MissionOutcome = 'pending' | 'completed' | 'failed' | 'aborted' | 'paused';

export interface MissionEvent {
  kind:
    | 'step_started'
    | 'step_done'
    | 'step_failed'
    | 'step_skipped'
    | 'step_retry'
    | 'step_escalated'
    | 'replan'
    | 'mission_paused'
    | 'mission_done';
  stepId?: string;
  message: string;
}

export interface MissionState {
  /** Stable mission id — the checkpoint directory (`.excalibur/missions/<id>/`). */
  id: string;
  mission: Mission;
  /** The working step set — escalate/replan mutate this (the live DAG). */
  steps: StepState[];
  log: MissionEvent[];
  /** Accumulated model spend (cents) across steps — drives the budget ceiling. */
  spentCents: number;
  done: boolean;
  outcome: MissionOutcome;
  /** Why a `paused` mission stopped (resume to continue). */
  pausedReason?: string;
}

/** Runs ONE capability step against a real (or fake) engine. */
export type CapabilityExecutor = (
  step: PlanStep,
  state: Readonly<MissionState>,
  signal?: AbortSignal,
) => Promise<StepResult>;

export type ReassessAction =
  | 'continue'
  | 'retry'
  | 'escalate'
  | 'replan'
  | 'skip'
  | 'abort'
  | 'done';

/** The adaptive decision after a step — the heart of "intelligent". */
export interface ReassessDecision {
  action: ReassessAction;
  reason: string;
  /** For `escalate`: the stronger capability to swap to (e.g. implement→parallelize). */
  escalateTo?: CapabilityKind;
  /** For `replan`: new steps to splice into the remaining plan. */
  addSteps?: PlanStep[];
}

/** Decides what to do after a step that warrants attention (a failure or a gate). */
export type Reassessor = (
  state: Readonly<MissionState>,
  lastStep: Readonly<StepState>,
  signal?: AbortSignal,
) => Promise<ReassessDecision>;

export interface RunMissionOptions {
  executor: CapabilityExecutor;
  /** Adaptive decisions; without it, a deterministic policy applies. */
  reassess?: Reassessor;
  /** Progress + checkpoint hook — fired on every state change (persist here). */
  onEvent?: (event: MissionEvent, state: Readonly<MissionState>) => void;
  signal?: AbortSignal;
  /** Hard bound on total step executions (runaway guard). Default 50. */
  maxSteps?: number;
  /** Per-step attempt cap (retry/escalate). Default 3. */
  maxAttempts?: number;
  /** Stable mission id (the checkpoint dir). Ignored when `resumeFrom` is set. */
  id?: string;
  /**
   * Resume a previously checkpointed mission: continue its DAG from where it
   * stopped (done steps stay done, pending/paused work runs, spend carries over).
   */
  resumeFrom?: MissionState;
  /** Budget ceiling in cents — at/over it the mission PAUSES (resumable). */
  budgetCents?: number;
  /** Wall-clock budget in ms — past it the mission PAUSES. Needs `now`. */
  maxDurationMs?: number;
  /** Injected clock for the time ceiling (kept out of core for determinism). */
  now?: () => number;
}

/** The deterministic fallback policy when no model reassessor is supplied. */
export function defaultReassess(lastStep: Readonly<StepState>): ReassessDecision {
  if (lastStep.result?.ok === true) {
    return { action: 'continue', reason: 'step succeeded' };
  }
  // A failed GATE stops the mission; a failed non-gate step is accepted and its
  // dependents are skipped (the rest of the mission still runs).
  return lastStep.step.gate
    ? { action: 'abort', reason: 'a gate step failed and no recovery is configured' }
    : { action: 'continue', reason: 'a non-gate step failed; continuing without its dependents' };
}

const isWorkStep = (k: CapabilityKind): boolean =>
  k === 'implement' || k === 'parallelize' || k === 'explore';

/** Initializes the mission state from a plan (every step pending). */
export function initMissionState(
  mission: Mission,
  plan: OrchestrationPlan,
  id = 'mission',
): MissionState {
  return {
    id,
    mission,
    steps: plan.steps.map((step) => ({ step, status: 'pending', attempts: 0 })),
    log: [],
    spentCents: 0,
    done: false,
    outcome: 'pending',
  };
}

/** The cents this step's executor reported, from `result.signals.costCents`. */
function stepCost(result: StepResult): number {
  const c = result.signals?.['costCents'];
  return typeof c === 'number' && Number.isFinite(c) ? c : 0;
}

/** Drives the mission's DAG to completion, adapting after each step. Never throws. */
export async function runMission(
  mission: Mission,
  plan: OrchestrationPlan,
  opts: RunMissionOptions,
): Promise<MissionState> {
  // Fresh run, or RESUME a checkpointed mission from where it stopped.
  const state = opts.resumeFrom ?? initMissionState(mission, plan, opts.id ?? 'mission');
  if (opts.resumeFrom !== undefined) {
    state.done = false;
    state.pausedReason = undefined as string | undefined;
  }
  const maxSteps = opts.maxSteps ?? 50;
  const maxAttempts = opts.maxAttempts ?? 3;
  const startedAt = opts.now?.() ?? 0;
  const byId = (id: string): StepState | undefined => state.steps.find((s) => s.step.id === id);
  const emit = (event: MissionEvent): void => {
    state.log.push(event);
    opts.onEvent?.(event, state);
  };
  const satisfied = (id: string): boolean => {
    const dep = byId(id);
    return dep === undefined || dep.status === 'done' || dep.status === 'skipped';
  };
  const depFailed = (id: string): boolean => byId(id)?.status === 'failed';

  let executed = 0;
  let aborted = false;
  let paused: string | null = null;

  while (!state.done && !aborted && executed < maxSteps) {
    if (opts.signal?.aborted === true) {
      aborted = true;
      break;
    }
    // Long-job governance: a budget/time ceiling PAUSES (resumable), not fails.
    if (opts.budgetCents !== undefined && state.spentCents >= opts.budgetCents) {
      paused = `budget ceiling reached (${state.spentCents}¢ ≥ ${opts.budgetCents}¢)`;
      break;
    }
    if (
      opts.maxDurationMs !== undefined &&
      opts.now !== undefined &&
      opts.now() - startedAt >= opts.maxDurationMs
    ) {
      paused = `time budget reached (${opts.maxDurationMs}ms)`;
      break;
    }

    // Skip any pending step whose dependency failed — it can never become ready.
    const blocked = state.steps.find(
      (s) => s.status === 'pending' && s.step.dependsOn.some((d) => depFailed(d)),
    );
    if (blocked !== undefined) {
      blocked.status = 'skipped';
      emit({ kind: 'step_skipped', stepId: blocked.step.id, message: 'dependency failed' });
      continue;
    }

    const ready = state.steps.find(
      (s) => s.status === 'pending' && s.step.dependsOn.every((d) => satisfied(d)),
    );
    if (ready === undefined) {
      break; // nothing left to run → terminal
    }

    // Run the step.
    ready.status = 'running';
    ready.attempts += 1;
    emit({ kind: 'step_started', stepId: ready.step.id, message: ready.step.objective });
    executed += 1;
    let result: StepResult;
    try {
      result = await opts.executor(ready.step, state, opts.signal);
    } catch (error) {
      result = { ok: false, summary: error instanceof Error ? error.message : String(error) };
    }
    ready.result = result;
    ready.status = result.ok ? 'done' : 'failed';
    state.spentCents += stepCost(result);
    emit({
      kind: result.ok ? 'step_done' : 'step_failed',
      stepId: ready.step.id,
      message: result.summary,
    });

    // Reassess only at the moments that matter — a failure or a gate boundary —
    // so a clean run is not slowed by a model call after every trivial step.
    const needsReassess = !result.ok || ready.step.gate;
    if (!needsReassess) {
      continue;
    }
    let decision: ReassessDecision;
    if (opts.reassess !== undefined) {
      try {
        decision = await opts.reassess(state, ready, opts.signal);
      } catch {
        decision = defaultReassess(ready);
      }
    } else {
      decision = defaultReassess(ready);
    }
    emit({
      kind: 'replan',
      stepId: ready.step.id,
      message: `${decision.action}: ${decision.reason}`,
    });

    switch (decision.action) {
      case 'abort':
        aborted = true;
        break;
      case 'done':
        state.done = true;
        break;
      case 'retry':
        if (ready.attempts < maxAttempts) {
          ready.status = 'pending';
          ready.result = undefined as StepResult | undefined;
          emit({ kind: 'step_retry', stepId: ready.step.id, message: 'retrying' });
        }
        break;
      case 'escalate':
        if (ready.attempts < maxAttempts) {
          const to = decision.escalateTo ?? 'parallelize';
          ready.step = { ...ready.step, capability: to };
          ready.status = 'pending';
          ready.result = undefined as StepResult | undefined;
          emit({ kind: 'step_escalated', stepId: ready.step.id, message: `→ ${to}` });
        }
        break;
      case 'replan':
        // A replan SUPERSEDES the just-finished step's failure with corrective
        // steps — so the failed step that triggered it no longer dooms the
        // outcome (the new steps now carry the work/gate semantics). If they too
        // fail, THEIR failures surface, so correctness is preserved.
        if (ready.status === 'failed') {
          ready.status = 'skipped';
          emit({ kind: 'step_skipped', stepId: ready.step.id, message: 'superseded by replan' });
        }
        spliceSteps(state, decision.addSteps ?? []);
        break;
      case 'continue':
      default:
        break; // accept the result as-is (failed stays failed → dependents skip)
    }
  }

  if (paused !== null) {
    // A paused mission is NOT done — it is resumable from this checkpoint.
    state.done = false;
    state.outcome = 'paused';
    state.pausedReason = paused;
    emit({ kind: 'mission_paused', message: paused });
    return state;
  }
  state.done = true;
  state.outcome = finalOutcome(state, aborted);
  emit({ kind: 'mission_done', message: state.outcome });
  return state;
}

/** Appends model-proposed steps to the live DAG, keeping ids unique + acyclic. */
function spliceSteps(state: MissionState, add: PlanStep[]): void {
  if (add.length === 0) return;
  const ids = new Set(state.steps.map((s) => s.step.id));
  const fresh: StepState[] = [];
  for (const raw of add) {
    let id = raw.id.length > 0 ? raw.id : `r${state.steps.length + fresh.length + 1}`;
    while (ids.has(id)) id = `${id}_`;
    ids.add(id);
    const dependsOn = raw.dependsOn.filter((d) => ids.has(d) && d !== id);
    fresh.push({ step: { ...raw, id, dependsOn }, status: 'pending', attempts: 0 });
  }
  const candidate = [...state.steps, ...fresh];
  // Only accept the splice if the DAG stays acyclic.
  if (topologicalWaves(candidate.map((s) => s.step)) !== null) {
    state.steps = candidate;
  }
}

/** completed unless a gate or a work step failed unrecovered, or the run was aborted. */
function finalOutcome(state: MissionState, aborted: boolean): MissionOutcome {
  if (aborted) return 'aborted';
  const failedGate = state.steps.some((s) => s.status === 'failed' && s.step.gate);
  const failedWork = state.steps.some(
    (s) => s.status === 'failed' && isWorkStep(s.step.capability),
  );
  return failedGate || failedWork ? 'failed' : 'completed';
}
