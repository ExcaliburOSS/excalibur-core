import { z } from 'zod';
import { autonomyLevelSchema } from './autonomy';
import { executionStyleSchema, runStatusSchema } from './enums';

/**
 * Provenance of a run created by forking another run from the time-machine: the
 * source run id and the step index the fork branched from (the cached prefix is
 * steps `0..atStep`). Present only on forked runs.
 */
export const forkOriginSchema = z.object({
  runId: z.string().min(1),
  /** Zero-based step index of the source run the fork branched from. */
  atStep: z.number().int().nonnegative(),
});
export type ForkOrigin = z.infer<typeof forkOriginSchema>;

/**
 * Local run artifact contract (OSS spec §11, Build Contract §4.1/§6).
 *
 * `run.json` inside `.excalibur/runs/<run-id>/` is a `RunRecord`. The record is
 * a superset of the OSS spec §11 example: the extra fields (`model`,
 * `executionStyle`, `methodology`, `completedAt`, `forkedFrom`) are nullable/
 * optional so older or minimal producers stay compatible.
 */
export const runRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  autonomyLevel: autonomyLevelSchema,
  workflow: z.string().min(1),
  methodology: z.string().nullable(),
  status: runStatusSchema,
  model: z.string().nullable(),
  executionStyle: executionStyleSchema.nullable(),
  /** ISO-8601 timestamp (UTC offset or `Z`). */
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  /**
   * Set when this run was created by forking another run from the time-machine.
   * Optional + nullable: ordinary runs omit it entirely (back-compatible).
   */
  forkedFrom: forkOriginSchema.nullable().optional(),
  /**
   * The work item this run executes against (work-item-centric cycle): runs and
   * agents are LINKED to a work item, so a work item can show its runs/patches.
   * Optional + nullable — ad-hoc runs omit it (back-compatible).
   */
  workItemId: z.string().nullable().optional(),
  /**
   * The PARENT run when this run is a child lane of a parallel orchestration
   * (AO4a swarm-as-run): a swarm fans out into a parent run plus one child run
   * per lane, so the dashboard/SSE/replay/audit can see and group parallel work.
   * Optional + nullable — ordinary (non-parallel) runs omit it (back-compatible).
   */
  parentRunId: z.string().nullable().optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** A run as stored on disk: its id, directory and parsed `run.json`. */
export interface LocalRun {
  id: string;
  dir: string;
  record: RunRecord;
}

/** Zod schema companion for `LocalRun` (useful for sync payload validation). */
export const localRunSchema = z.object({
  id: z.string().min(1),
  dir: z.string().min(1),
  record: runRecordSchema,
});

/**
 * Canonical artifact file names a local run may produce inside its run
 * directory (OSS spec §11). Not every workflow writes every file.
 */
export const RUN_ARTIFACT_FILES = [
  'run.json',
  'workflow.yaml',
  'methodology.yaml',
  'events.jsonl',
  'model-calls.jsonl',
  'input.md',
  'context.md',
  'diff.patch',
  'summary.md',
  'review.md',
  'test-results.json',
  'tests.log',
  'pr-summary.md',
] as const;
export type RunArtifactFile = (typeof RUN_ARTIFACT_FILES)[number];
