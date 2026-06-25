/**
 * The meta-orchestrator (project §"meta-orchestrator"). The brain that, given a
 * NATURAL goal, interprets the need and PROACTIVELY composes Excalibur's full
 * toolbox into a plan, then drives it adaptively — the layer that turns "a strong
 * agent + a one-shot shape picker" into an autonomous orchestrator that beats
 * Claude Code / OpenCode on long jobs.
 *
 * This file is the vocabulary: a {@link Mission} (the interpreted goal) and an
 * {@link OrchestrationPlan} (the auto-authored capability DAG). It carries NO
 * model SDK and NO execution — pure data shapes, so the planning + supervision
 * layers stay unit-testable.
 */

/**
 * One of Excalibur's first-class capabilities the planner can compose. Each maps
 * to a real engine the supervisor drives (see the capability catalog). This is
 * the closed set the meta-orchestrator reasons over.
 */
export type CapabilityKind =
  /** Read-only recon: map the relevant files/subsystems BEFORE acting (AO9). */
  | 'understand'
  /** Clarify an ambiguous idea with the user before building (discovery flow). */
  | 'discover'
  /** Produce an explicit, approvable plan. */
  | 'plan'
  /** A single agentic run (the native tool loop) does the work. */
  | 'implement'
  /** Swarm: fan out independent subtasks as parallel agents (worktrees + merge). */
  | 'parallelize'
  /** Best-of-N: try several approaches in parallel and keep the best. */
  | 'explore'
  /** Run the test suite. */
  | 'test'
  /** Adversarial verification / claim-ledger gate over the work. */
  | 'verify'
  /** Code review of the change. */
  | 'review'
  /** Land the work: commit / open a PR. */
  | 'ship';

export const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  'understand',
  'discover',
  'plan',
  'implement',
  'parallelize',
  'explore',
  'test',
  'verify',
  'review',
  'ship',
];

/** How big the job is — drives whether to plan, parallelize, and how to govern it. */
export type MissionComplexity = 'trivial' | 'small' | 'medium' | 'large' | 'epic';
export const MISSION_COMPLEXITIES: readonly MissionComplexity[] = [
  'trivial',
  'small',
  'medium',
  'large',
  'epic',
];

/** How risky the change is — drives gating (verify/review) and approval posture. */
export type MissionRisk = 'low' | 'medium' | 'high';
export const MISSION_RISKS: readonly MissionRisk[] = ['low', 'medium', 'high'];

/**
 * The interpreted goal: what the user REALLY wants, sized and shaped so the
 * planner can compose the right capabilities. Produced by `interpretMission`.
 */
export interface Mission {
  /** The user's goal, verbatim. */
  goal: string;
  /** One-line interpretation of the underlying need (the "what they really want"). */
  interpretation: string;
  complexity: MissionComplexity;
  risk: MissionRisk;
  /** Concrete, checkable conditions that mean the goal is DONE. */
  successCriteria: string[];
  /** The goal is ambiguous → clarify (discovery) before building. */
  needsClarification: boolean;
  /** The codebase must be mapped (read-only) before a plan is trustworthy. */
  needsUnderstanding: boolean;
  /** The work splits into independent parts that could run in parallel. */
  parallelizable: boolean;
}

/** One node of the capability DAG — a capability invocation with dependencies. */
export interface PlanStep {
  /** Unique within the plan (referenced by other steps' `dependsOn`). */
  id: string;
  capability: CapabilityKind;
  /** What this step must accomplish — fed to the underlying engine as its task. */
  objective: string;
  /** Step ids that must finish before this one starts (the DAG edges). */
  dependsOn: string[];
  /** A failure here STOPS the mission (a hard gate) vs. is recoverable/optional. */
  gate: boolean;
}

/** The auto-authored strategy: the capability DAG plus the rationale to narrate. */
export interface OrchestrationPlan {
  /** The mission goal this plan fulfils. */
  goal: string;
  /** The capability steps, as a DAG (ordering comes from `dependsOn`, not array order). */
  steps: PlanStep[];
  /** One-paragraph plain-language strategy (narrated to the user). */
  rationale: string;
}
