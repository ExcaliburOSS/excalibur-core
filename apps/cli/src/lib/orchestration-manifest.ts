import type { SwarmSubtask } from './swarm';

/**
 * AO5 — the orchestration MANIFEST: a deterministic, inspectable, re-runnable
 * record of a parallel run (the foundation of Claude-Code-Workflow-tool parity).
 * It captures WHAT ran (the lanes, their instructions + dependency waves) and
 * HOW it turned out (per-lane status + cost), persisted as `orchestration.json`
 * on the parent run. A later `--from-manifest` re-runs it; `resume` re-dispatches
 * only the failed/pending lanes.
 */

export interface OrchestrationManifestLane {
  id: string;
  title: string;
  instruction: string;
  dependsOn: string[];
  /** Outcome: `done` (applied changes), `empty` (ran, no diff), `failed`. */
  outcome: 'done' | 'empty' | 'failed';
  costCents: number | null;
  /** The child run this lane persisted to (AO4a), when available. */
  runId?: string;
}

export interface OrchestrationManifest {
  version: 1;
  task: string;
  /** `staged` when the lanes ran in dependency waves; `flat` for one parallel wave. */
  mode: 'flat' | 'staged';
  parentRunId: string;
  /** ISO timestamp — stamped by the caller (the lib never reads the clock). */
  createdAt: string;
  /** Lane-id groupings in execution order (one wave for `flat`). */
  waves: string[][];
  lanes: OrchestrationManifestLane[];
}

export interface ManifestLaneOutcome {
  id: string;
  outcome: 'done' | 'empty' | 'failed';
  costCents: number | null;
  runId?: string;
}

/**
 * Builds the manifest (pure). `subtasks` carries the instructions + dependsOn;
 * `waves` is the executed lane-id grouping (a single wave for the flat path);
 * `outcomes` carries each lane's result. Lane order follows `subtasks`.
 */
export function buildOrchestrationManifest(input: {
  task: string;
  parentRunId: string;
  createdAt: string;
  mode: 'flat' | 'staged';
  subtasks: ReadonlyArray<SwarmSubtask>;
  waves: ReadonlyArray<ReadonlyArray<string>>;
  outcomes: ReadonlyArray<ManifestLaneOutcome>;
}): OrchestrationManifest {
  const outcomeById = new Map(input.outcomes.map((o) => [o.id, o]));
  const lanes: OrchestrationManifestLane[] = input.subtasks.map((s) => {
    const o = outcomeById.get(s.id);
    return {
      id: s.id,
      title: s.title,
      instruction: s.instruction,
      dependsOn: [...(s.dependsOn ?? [])],
      outcome: o?.outcome ?? 'empty',
      costCents: o?.costCents ?? null,
      ...(o?.runId !== undefined ? { runId: o.runId } : {}),
    };
  });
  return {
    version: 1,
    task: input.task,
    mode: input.mode,
    parentRunId: input.parentRunId,
    createdAt: input.createdAt,
    waves: input.waves.map((w) => [...w]),
    lanes,
  };
}
