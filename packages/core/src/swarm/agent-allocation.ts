import type { TaskType } from '../onboarding/onboarding';

/**
 * Automatic swarm sizing — `planAgentAllocation` (plan §"Asignación automática
 * de agentes").
 *
 * The developer NEVER fixes the number of agents. Excalibur sizes the swarm
 * from the envergadura of the task/plan, deterministically and explainably
 * (rule first; IA enriches later — same philosophy as `classifyTaskIntent`, the
 * Discovery scoring, and the workflow selector). A number is at most an OPTIONAL
 * cap, never a required choice.
 *
 * This is a PURE function (no I/O, no clock, no randomness): given the task
 * signals it returns a stable allocation + a human-readable `reason`. It runs at
 * two moments:
 *
 *  1. **Pre-plan estimate** — from `classifyTaskIntent` (`taskType`/`sensitive`)
 *     plus a rough count of affected modules (`affectedUnits`, from the
 *     context-engine). No decomposition yet → `decomposition` is empty.
 *  2. **Post-plan precise** — once `plan`/`spec` emitted `plan.md`/`tasks.md`,
 *     pass the decomposed `subtasks`; the allocator assigns ONE agent per
 *     INDEPENDENT subtask (no dependency on another subtask in the set). The
 *     plan's envergadura determines the swarm; dependent subtasks run after.
 *
 * The actual fan-out/fan-in EXECUTION (parallel implementers in isolated git
 * worktrees + a merge coordinator) is the M3 follow-up that needs real agents;
 * this function is the deterministic "brain" that decides the shape, used by the
 * `run` pre-flight preview ("Sized to N agents because: …") and, later, by the
 * orchestrator.
 */

/** A unit of work from a decomposed plan (`tasks.md`). */
export interface Subtask {
  /** Stable id within the plan (e.g. `t1`). */
  id: string;
  /** Short human-readable title. */
  title: string;
  /**
   * Ids of OTHER subtasks this one depends on. Empty/absent = independent (can
   * start immediately, in parallel with the other independent subtasks).
   */
  dependsOn?: ReadonlyArray<string>;
  /** This subtask touches a sensitive area (biases the run toward review). */
  sensitive?: boolean;
}

/** The signals `planAgentAllocation` sizes the swarm from. */
export interface AgentAllocationInput {
  /** Coarse task class from {@link classifyTaskIntent}. */
  taskType: TaskType;
  /**
   * The task touches a sensitive area (auth/payments/migrations/…). Biases
   * toward FEWER parallel agents + more review — sensitive code is not where you
   * want a large uncoordinated swarm.
   */
  sensitive: boolean;
  /**
   * Pre-plan estimate of how many distinct modules/files the task will touch
   * (from the context-engine / path mentions). Used ONLY when `subtasks` is
   * absent. Defaults to 1.
   */
  affectedUnits?: number;
  /**
   * Decomposed plan subtasks (post-plan). When present, the count is driven by
   * the number of INDEPENDENT subtasks — precise, not estimated.
   */
  subtasks?: ReadonlyArray<Subtask>;
  /**
   * Hard ceiling: the org policy `maxAgentsPerRun` or the CLI `--max-agents`.
   * Never exceeded. `undefined` = no ceiling.
   */
  maxAgents?: number;
  /**
   * Power-user explicit count (CLI `--agents N`) — an OVERRIDE of the automatic
   * estimate, still clamped by `maxAgents`. `undefined` = let the allocator
   * decide (the default, `auto`).
   */
  requested?: number;
}

/** The result of {@link planAgentAllocation}. */
export interface AgentAllocation {
  /** How many agents to run (always ≥ 1). */
  agentCount: number;
  /**
   * The INDEPENDENT subtasks that each get an agent (post-plan). Empty for a
   * pre-plan estimate (the count is an estimate, not yet a decomposition).
   */
  decomposition: Subtask[];
  /** `parallel` when more than one agent runs; `sequential` otherwise. */
  parallelism: 'sequential' | 'parallel';
  /** Human-readable explanation for the preview ("Sized to N agents because: …"). */
  reason: string;
  /** Which caps/biases reduced the count, in the order applied (for audit + preview). */
  capsApplied: string[];
}

/**
 * Fixed number of parallel candidates for an `alternatives`/explore task —
 * distinct attempts to compare, not a decomposition. Kept small + deterministic.
 */
const EXPLORE_CANDIDATES = 3;

/** Upper bound on the count a sensitive task is allowed to fan out to. */
const SENSITIVE_MAX = 2;

/** Clamp helper (pure). */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * The independent subtasks of a plan: those whose `dependsOn` references no
 * OTHER subtask in the set (an unknown/dangling id does not count as a real
 * dependency). These can run in parallel; dependent subtasks run after.
 */
function independentSubtasks(subtasks: ReadonlyArray<Subtask>): Subtask[] {
  const ids = new Set(subtasks.map((s) => s.id));
  return subtasks.filter((s) => !(s.dependsOn ?? []).some((dep) => ids.has(dep)));
}

/**
 * Pre-plan base estimate from the task class + affected-module count. Returns
 * the count and a short phrase explaining it.
 */
function estimateFromIntent(
  taskType: TaskType,
  affectedUnits: number,
): { base: number; phrase: string } {
  const units = Math.max(1, Math.floor(affectedUnits));
  switch (taskType) {
    case 'bugfix':
      // A bug is a focused change — one agent, regardless of repo size.
      return { base: 1, phrase: 'a bugfix is a focused, single-agent change' };
    case 'docs':
      return { base: 1, phrase: 'a docs change is single-agent' };
    case 'ambiguous':
      // Don't fan out into an unclear task — Discovery should clarify it first.
      return {
        base: 1,
        phrase: 'the task is ambiguous (clarify with Discovery before fanning out)',
      };
    case 'alternatives':
      return {
        base: EXPLORE_CANDIDATES,
        phrase: `exploring ${EXPLORE_CANDIDATES} alternative approaches in parallel`,
      };
    case 'migration':
      // Migrations fan out across modules (one agent per module touched).
      return { base: units, phrase: `a migration spanning ~${units} module(s)` };
    case 'refactor':
    case 'feature':
    case 'security':
      // Scale gently: roughly one agent per two affected modules.
      return {
        base: Math.max(1, Math.ceil(units / 2)),
        phrase: `a ${taskType} touching ~${units} module(s)`,
      };
    default:
      return { base: 1, phrase: 'a single-agent task' };
  }
}

/**
 * Sizes the swarm for a run. Deterministic and explainable: a developer reading
 * `reason` always understands WHY it chose N. Returns at least one agent.
 */
export function planAgentAllocation(input: AgentAllocationInput): AgentAllocation {
  const capsApplied: string[] = [];

  // 1. Base count + the reason phrase: precise from a decomposed plan, else an
  //    estimate from the task class.
  let base: number;
  let phrase: string;
  let decomposition: Subtask[] = [];
  if (input.subtasks !== undefined && input.subtasks.length > 0) {
    decomposition = independentSubtasks(input.subtasks);
    base = Math.max(1, decomposition.length);
    const dependent = input.subtasks.length - decomposition.length;
    phrase =
      `the plan has ${decomposition.length} independent subtask(s)` +
      (dependent > 0 ? ` (+${dependent} dependent, run after)` : '');
  } else {
    const estimate = estimateFromIntent(input.taskType, input.affectedUnits ?? 1);
    base = estimate.base;
    phrase = estimate.phrase;
  }

  // 2. Power-user override (`--agents N`): replaces the estimate, still capped below.
  if (input.requested !== undefined && Number.isFinite(input.requested)) {
    base = Math.max(1, Math.floor(input.requested));
    phrase = `you requested ${base} agent(s)`;
    capsApplied.push('requested');
  }

  // 3. Sensitive areas: bias toward fewer parallel agents + more review.
  if (input.sensitive && base > SENSITIVE_MAX) {
    base = SENSITIVE_MAX;
    phrase += `, reduced to ${SENSITIVE_MAX} for sensitive areas (more review, less parallel)`;
    capsApplied.push('sensitive');
  }

  // 4. Hard ceiling (policy maxAgentsPerRun / --max-agents): never exceeded.
  let agentCount = base;
  if (input.maxAgents !== undefined && Number.isFinite(input.maxAgents)) {
    const ceiling = Math.max(1, Math.floor(input.maxAgents));
    if (agentCount > ceiling) {
      agentCount = ceiling;
      phrase += `, capped at ${ceiling} by the agent limit`;
      capsApplied.push('maxAgents');
    }
  }

  agentCount = clamp(agentCount, 1, agentCount);
  // If the count was capped below the decomposition size, only that many
  // subtasks get an agent this wave; surface exactly which ones.
  if (decomposition.length > agentCount) {
    decomposition = decomposition.slice(0, agentCount);
  }

  const parallelism: AgentAllocation['parallelism'] = agentCount > 1 ? 'parallel' : 'sequential';
  return {
    agentCount,
    decomposition,
    parallelism,
    reason: `Sized to ${agentCount} agent${agentCount === 1 ? '' : 's'} because ${phrase}.`,
    capsApplied,
  };
}
