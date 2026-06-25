import type { CapabilityKind } from './types';

/**
 * The capability catalog the planner reasons over: a plain-language description
 * of each first-class Excalibur capability and WHEN to choose it. This is what
 * makes the meta-orchestrator proactive across the WHOLE toolbox — the planning
 * model is handed this menu and composes from it, instead of being limited to a
 * single one-shot shape. Keep `useWhen` sharp and mutually distinguishing.
 */
export interface CapabilitySpec {
  kind: CapabilityKind;
  /** What the capability does. */
  summary: string;
  /** When the planner should pick it. */
  useWhen: string;
  /** Fans out into parallel work (informs concurrency + cost). */
  parallel: boolean;
}

export const CAPABILITY_CATALOG: readonly CapabilitySpec[] = [
  {
    kind: 'understand',
    summary:
      'A read-only exploration that maps the relevant files, subsystems, and what already exists vs. is missing.',
    useWhen:
      'The codebase is unfamiliar or the change touches code whose shape you must know before planning. Almost always first for a non-trivial goal.',
    parallel: false,
  },
  {
    kind: 'discover',
    summary:
      'An interactive clarification flow that asks the user targeted questions to pin down an ambiguous idea.',
    useWhen:
      'The goal is vague, underspecified, or could mean several different things — clarify BEFORE building.',
    parallel: false,
  },
  {
    kind: 'plan',
    summary: 'Produces an explicit, approvable implementation plan.',
    useWhen: 'A multi-step change worth agreeing on an approach before writing code.',
    parallel: false,
  },
  {
    kind: 'implement',
    summary: 'A single agentic run that reads, edits, and runs commands to do the work.',
    useWhen: 'The work is a coherent, sequential change best done by one focused agent.',
    parallel: false,
  },
  {
    kind: 'parallelize',
    summary:
      'A swarm: fans the work out into independent subtasks, each an agent in its own git worktree, then merges them.',
    useWhen:
      'The goal splits into genuinely INDEPENDENT pieces (e.g. the same change across many modules) that can run at once.',
    parallel: true,
  },
  {
    kind: 'explore',
    summary: 'Best-of-N: runs several candidate approaches in parallel and keeps the best one.',
    useWhen:
      'The right approach is uncertain and worth trying a few ways to compare — design-sensitive or risky changes.',
    parallel: true,
  },
  {
    kind: 'test',
    summary: 'Runs the project test suite.',
    useWhen: 'After implementing, to confirm the change works and nothing regressed.',
    parallel: false,
  },
  {
    kind: 'verify',
    summary:
      'An adversarial verification / claim-ledger gate that tries to REFUTE that the work is correct and complete.',
    useWhen:
      'Medium/high-risk changes where "the model said it works" is not enough — gate before shipping.',
    parallel: false,
  },
  {
    kind: 'review',
    summary: 'A code review of the diff for correctness, regressions, and quality.',
    useWhen: 'Before shipping a substantive change, especially user-facing or security-relevant.',
    parallel: false,
  },
  {
    kind: 'ship',
    summary: 'Lands the work: commits and/or opens a pull request.',
    useWhen:
      'The final step once the change is implemented and verified — only when the goal asks to land it.',
    parallel: false,
  },
];

/** Renders the catalog as a compact menu for the planning prompt. */
export function renderCapabilityCatalog(): string {
  return CAPABILITY_CATALOG.map(
    (c) => `- ${c.kind}${c.parallel ? ' (parallel)' : ''}: ${c.summary} Use when: ${c.useWhen}`,
  ).join('\n');
}
