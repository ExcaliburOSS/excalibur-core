import { z } from 'zod';

/**
 * Excalibur autonomy levels. Identical in Excalibur Core and Excalibur Enterprise.
 *
 * Level 0 — Review: AI does not modify code.
 * Level 1 — Assist: AI explains, suggests and helps, but does not produce automatic diffs
 *           unless requested.
 * Level 2 — Propose Patch: AI generates a patch/diff, but does not apply it automatically.
 * Level 3 — Implement in Branch: AI creates or uses a local branch/worktree and modifies
 *           code in isolation.
 * Level 4 — Full Agentic Workflow: AI executes a full workflow with phases, tools, tests
 *           and outputs.
 */
export const AUTONOMY_LEVELS = {
  REVIEW: 0,
  ASSIST: 1,
  PROPOSE_PATCH: 2,
  IMPLEMENT_IN_BRANCH: 3,
  FULL_AGENTIC: 4,
} as const;

export const autonomyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

export const AUTONOMY_LEVEL_LABELS: Record<AutonomyLevel, string> = {
  0: 'Level 0 — Review',
  1: 'Level 1 — Assist',
  2: 'Level 2 — Propose Patch',
  3: 'Level 3 — Implement in Branch',
  4: 'Level 4 — Full Agentic Workflow',
};

export const AUTONOMY_LEVEL_DESCRIPTIONS: Record<AutonomyLevel, string> = {
  0: 'AI does not modify code.',
  1: 'AI explains, suggests and helps, but does not produce automatic diffs unless requested.',
  2: 'AI generates a patch/diff, but does not apply it automatically.',
  3: 'AI creates or uses a local branch/worktree and modifies code in isolation.',
  4: 'AI executes a full workflow with phases, tools, tests and outputs.',
};

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return autonomyLevelSchema.safeParse(value).success;
}
