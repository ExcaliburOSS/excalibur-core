import { RunManager } from '@excalibur/core';
import type { ChronogramDto, ChronogramLaneDto, ChronogramLaneState } from '@excalibur/shared';
import {
  loadOrchestrationControl,
  loadOrchestrationManifest,
  loadOrchestrationPlan,
} from './orchestration-manifest';

/**
 * AO6 Pillar 2 — the orchestration CHRONOGRAM builder. Joins the wave/DAG
 * STRUCTURE (from `orchestration-plan.json`, written at swarm start; or the
 * outcome `orchestration.json`; or a flat fallback derived from the child runs)
 * with the LIVE per-lane child-run state/cost/timing, producing the
 * {@link ChronogramDto} that feeds BOTH the dashboard timeline and the TTY
 * `renderChronogram` — one model, two presenters, like `reduceRail`. The pure
 * {@link buildChronogram} is snapshot-testable without a run store.
 */

/** Per-lane child-run facts the chronogram joins onto the plan structure. */
export interface ChronogramLaneRun {
  runId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  costCents: number | null;
}

/** Maps a child-run status (+ optional final outcome) to a chronogram lane state. */
export function laneStateOf(
  childStatus: string | null,
  outcome?: 'done' | 'empty' | 'failed',
): ChronogramLaneState {
  // A recorded final outcome (from the manifest) wins — it distinguishes a lane
  // that ran but produced no diff (`empty`) from one that landed changes (`done`).
  if (outcome === 'failed') return 'failed';
  if (outcome === 'empty') return 'empty';
  if (outcome === 'done') return 'done';
  switch (childStatus) {
    case 'running':
    case 'waiting_approval':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

/** Finished wall-clock span (completedAt − startedAt); null while live or unparseable. */
function durationMsOf(startedAt: string | null, completedAt: string | null): number | null {
  if (startedAt === null || completedAt === null) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(completedAt);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, b - a);
}

/** Builds the chronogram DTO from the plan structure + live per-lane run facts (pure). */
export function buildChronogram(input: {
  parentRunId: string;
  task: string;
  mode: 'flat' | 'staged';
  status: string;
  startedAt: string;
  completedAt: string | null;
  workItemId: string | null;
  waves: ReadonlyArray<ReadonlyArray<string>>;
  lanes: ReadonlyArray<{
    id: string;
    title: string;
    instruction: string;
    dependsOn: ReadonlyArray<string>;
    runId: string | null;
  }>;
  outcomes?: ReadonlyMap<string, 'done' | 'empty' | 'failed'>;
  runsById: ReadonlyMap<string, ChronogramLaneRun>;
  paused?: boolean;
}): ChronogramDto {
  const waveOf = new Map<string, number>();
  input.waves.forEach((wave, index) => {
    for (const id of wave) waveOf.set(id, index);
  });
  let total = 0;
  let sawCost = false;
  const lanes: ChronogramLaneDto[] = input.lanes.map((lane) => {
    const run = lane.runId !== null ? input.runsById.get(lane.runId) : undefined;
    const cost = run?.costCents ?? null;
    if (cost !== null) {
      total += cost;
      sawCost = true;
    }
    return {
      id: lane.id,
      title: lane.title,
      instruction: lane.instruction,
      wave: waveOf.get(lane.id) ?? 0,
      dependsOn: [...lane.dependsOn],
      state: laneStateOf(run?.status ?? null, input.outcomes?.get(lane.id)),
      runId: lane.runId,
      costCents: cost,
      startedAt: run?.startedAt ?? null,
      completedAt: run?.completedAt ?? null,
      durationMs: durationMsOf(run?.startedAt ?? null, run?.completedAt ?? null),
    };
  });
  return {
    parentRunId: input.parentRunId,
    task: input.task,
    mode: input.mode,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    workItemId: input.workItemId,
    waves: input.waves.map((w) => [...w]),
    lanes,
    totalCostCents: sawCost ? total : null,
    paused: input.paused ?? false,
  };
}

/**
 * Resolves a parent run id into a chronogram (I/O entry for `serve` + the CLI).
 * Prefers the live PLAN structure, falls back to the outcome MANIFEST, then to a
 * single flat wave derived from the child runs (legacy orchestrations with
 * neither artifact). Returns null only when the id is not an orchestration at all.
 */
export function buildChronogramForRun(repoRoot: string, parentRunId: string): ChronogramDto | null {
  const manager = new RunManager(repoRoot);
  let parent: ReturnType<RunManager['getRun']> | null;
  try {
    parent = manager.getRun(parentRunId);
  } catch {
    parent = null;
  }
  const children = manager.listRuns().filter((r) => r.record.parentRunId === parentRunId);
  if (parent === null && children.length === 0) return null;

  const costOf = (runId: string): number | null => {
    const calls = manager.readModelCalls(runId);
    return calls.some((c) => c.costCents != null)
      ? calls.reduce((acc, c) => acc + (c.costCents ?? 0), 0)
      : null;
  };
  const runsById = new Map<string, ChronogramLaneRun>();
  for (const child of children) {
    runsById.set(child.record.id, {
      runId: child.record.id,
      status: child.record.status,
      startedAt: child.record.startedAt ?? null,
      completedAt: child.record.completedAt ?? null,
      costCents: costOf(child.record.id),
    });
  }

  const status = parent?.record.status ?? 'running';
  const startedAt = parent?.record.startedAt ?? children[0]?.record.startedAt ?? parentRunId;
  const completedAt = parent?.record.completedAt ?? null;
  const workItemId = parent?.record.workItemId ?? null;

  const plan = loadOrchestrationPlan(repoRoot, parentRunId);
  const manifest = loadOrchestrationManifest(repoRoot, parentRunId);
  const outcomes =
    manifest !== null ? new Map(manifest.lanes.map((l) => [l.id, l.outcome] as const)) : undefined;
  const paused = loadOrchestrationControl(repoRoot, parentRunId)?.paused ?? false;

  if (plan !== null) {
    return buildChronogram({
      parentRunId,
      task: plan.task,
      mode: plan.mode,
      status,
      startedAt,
      completedAt,
      workItemId,
      waves: plan.waves,
      lanes: plan.lanes.map((l) => ({
        id: l.id,
        title: l.title,
        instruction: l.instruction,
        dependsOn: l.dependsOn,
        runId: l.runId ?? null,
      })),
      ...(outcomes !== undefined ? { outcomes } : {}),
      runsById,
      paused,
    });
  }
  if (manifest !== null) {
    return buildChronogram({
      parentRunId,
      task: manifest.task,
      mode: manifest.mode,
      status,
      startedAt,
      completedAt,
      workItemId,
      waves: manifest.waves,
      lanes: manifest.lanes.map((l) => ({
        id: l.id,
        title: l.title,
        instruction: l.instruction,
        dependsOn: l.dependsOn,
        runId: l.runId ?? null,
      })),
      outcomes: outcomes ?? new Map(),
      runsById,
      paused,
    });
  }
  // Legacy fallback: neither artifact — one flat wave of the child runs as lanes.
  const laneIds = children.map((c) => c.record.id);
  return buildChronogram({
    parentRunId,
    task: parent?.record.title ?? `orchestration ${parentRunId}`,
    mode: 'flat',
    status,
    startedAt,
    completedAt,
    workItemId,
    waves: [laneIds],
    lanes: children.map((c) => ({
      id: c.record.id,
      title: c.record.title,
      instruction: '',
      dependsOn: [],
      runId: c.record.id,
    })),
    runsById,
    paused,
  });
}
