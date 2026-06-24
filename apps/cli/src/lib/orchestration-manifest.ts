import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunManager } from '@excalibur/core';
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
  /**
   * AO7-1 — content signature = hash of (instruction + sorted deps + role). Lets a
   * later resume detect which lanes are UNCHANGED (content-addressed reuse) vs
   * edited, so only changed lanes + their dependents re-run. Optional for back-compat
   * with manifests written before AO7-1.
   */
  signature?: string;
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

/** One lane of the orchestration PLAN (the structure, known at swarm start). */
export interface OrchestrationPlanLane {
  id: string;
  title: string;
  instruction: string;
  dependsOn: string[];
  /** The child run this lane streams to (filled in as lanes are dispatched). */
  runId?: string;
}

/**
 * AO6 Pillar 2 — the orchestration PLAN: the wave/DAG STRUCTURE of a swarm,
 * persisted as `orchestration-plan.json` on the parent run AT START (unlike the
 * outcome `orchestration.json`, which is written at the end). This is what lets
 * the LIVE chronogram render the DAG immediately and fill it wave-by-wave as the
 * child runs progress. Shares the manifest's wave/lane vocabulary.
 */
export interface OrchestrationPlan {
  version: 1;
  task: string;
  mode: 'flat' | 'staged';
  parentRunId: string;
  /** ISO timestamp — stamped by the caller (the lib never reads the clock). */
  createdAt: string;
  waves: string[][];
  lanes: OrchestrationPlanLane[];
}

/** Reads + validates a run's `orchestration-plan.json`; null if absent/wrong shape. */
export function loadOrchestrationPlan(repoRoot: string, runId: string): OrchestrationPlan | null {
  try {
    const dir = new RunManager(repoRoot).getRun(runId).dir;
    const raw = JSON.parse(readFileSync(join(dir, 'orchestration-plan.json'), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const p = raw as Partial<OrchestrationPlan>;
    if (p.version !== 1 || !Array.isArray(p.lanes) || !Array.isArray(p.waves)) return null;
    return p as OrchestrationPlan;
  } catch {
    return null;
  }
}

/**
 * AO6 Pillar 3 — the orchestration CONTROL flag, persisted as
 * `orchestration-control.json` on the parent run. A live swarm's lane gate polls
 * it: while `paused` is true it holds (no new lanes dispatched; in-flight finish),
 * resuming when cleared. Cross-process (the dashboard / a second CLI sets it; the
 * running swarm reads it).
 */
export interface OrchestrationControl {
  paused: boolean;
  /** ISO timestamp of the last pause (informational). */
  pausedAt?: string;
}

/** Reads a run's `orchestration-control.json`; null if absent/unreadable. */
export function loadOrchestrationControl(
  repoRoot: string,
  runId: string,
): OrchestrationControl | null {
  try {
    const dir = new RunManager(repoRoot).getRun(runId).dir;
    const raw = JSON.parse(
      readFileSync(join(dir, 'orchestration-control.json'), 'utf8'),
    ) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const c = raw as Partial<OrchestrationControl>;
    return {
      paused: c.paused === true,
      ...(typeof c.pausedAt === 'string' ? { pausedAt: c.pausedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Sets the paused flag on a run's control file (best-effort, returns success). */
export function setOrchestrationPaused(
  repoRoot: string,
  runId: string,
  paused: boolean,
  nowIso: string,
): boolean {
  try {
    const control: OrchestrationControl = paused
      ? { paused: true, pausedAt: nowIso }
      : { paused: false };
    new RunManager(repoRoot).writeArtifact(
      runId,
      'orchestration-control.json',
      JSON.stringify(control, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

export interface ManifestLaneOutcome {
  id: string;
  outcome: 'done' | 'empty' | 'failed';
  costCents: number | null;
  runId?: string;
}

/**
 * AO7-1 — a lane's CONTENT signature: a stable hash of what determines its work
 * (instruction + sorted dependsOn + role). Two lanes with the same signature are
 * interchangeable for resume; an edited instruction/role/deps changes it, marking
 * the lane (and its dependents) for re-run. Pure + deterministic.
 */
export function laneSignature(lane: {
  instruction: string;
  dependsOn?: readonly string[];
  role?: string;
}): string {
  const material = JSON.stringify([
    lane.instruction.trim(),
    [...(lane.dependsOn ?? [])].sort(),
    lane.role ?? '',
  ]);
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
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
      signature: laneSignature(s),
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

/** Reads + validates a run's `orchestration.json`; null if absent/unreadable/wrong shape. */
export function loadOrchestrationManifest(
  repoRoot: string,
  runId: string,
): OrchestrationManifest | null {
  try {
    const dir = new RunManager(repoRoot).getRun(runId).dir;
    const raw = JSON.parse(readFileSync(join(dir, 'orchestration.json'), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const m = raw as Partial<OrchestrationManifest>;
    if (m.version !== 1 || !Array.isArray(m.lanes) || typeof m.task !== 'string') return null;
    return m as OrchestrationManifest;
  } catch {
    return null;
  }
}

/** The newest run that is a parallel-orchestration parent (workflow `swarm`). */
export function latestOrchestrationRunId(repoRoot: string): string | null {
  const swarms = new RunManager(repoRoot).listRuns().filter((r) => r.record.workflow === 'swarm');
  // listRuns is chronological by id; the last is newest.
  return swarms.length > 0 ? swarms[swarms.length - 1]!.id : null;
}

/**
 * Reconstructs the runnable {@link SwarmSubtask}s from a manifest (pure). For a
 * RESUME, lanes whose recorded outcome was `done` are dropped — only the
 * failed/empty lanes re-dispatch; dependsOn is preserved (the staged executor
 * re-levelizes, ignoring deps on now-dropped completed lanes).
 */
export function manifestToSubtasks(
  manifest: OrchestrationManifest,
  options: { resume?: boolean } = {},
): SwarmSubtask[] {
  const lanes =
    options.resume === true ? manifest.lanes.filter((l) => l.outcome !== 'done') : manifest.lanes;
  return lanes.map((l) => ({
    id: l.id,
    title: l.title,
    instruction: l.instruction,
    ...(l.dependsOn.length > 0 ? { dependsOn: l.dependsOn } : {}),
  }));
}

export interface ResumePlan {
  /** Lanes that must re-run (changed/failed/empty, plus their transitive dependents). */
  rerun: SwarmSubtask[];
  /** Ids whose prior `done` result is reused as-is (unchanged + all deps reused). */
  reusedIds: string[];
}

/**
 * AO7-1 — CONTENT-ADDRESSED resume planner (pure). Given a prior manifest and the
 * lanes to run now (defaults to the manifest's own lanes — the plain `--resume`
 * case; pass a freshly-compiled set for an edited `--spec … --resume`), decide
 * which lanes must RE-RUN vs can REUSE their prior `done` result. A lane re-runs
 * when it is new, its prior outcome was not `done`, its content signature changed,
 * OR any lane it (transitively) depends on re-runs — so editing one step correctly
 * invalidates everything downstream, exactly like a journal resume. Reused lanes'
 * applied work is assumed present in the tree (the prior run was applied).
 */
export function planResume(
  manifest: OrchestrationManifest,
  newSubtasks?: ReadonlyArray<SwarmSubtask>,
): ResumePlan {
  const subtasks: SwarmSubtask[] =
    newSubtasks !== undefined ? [...newSubtasks] : manifestToSubtasks(manifest);
  const prevById = new Map(manifest.lanes.map((l) => [l.id, l]));
  const rerun = new Set<string>();
  // Seed: a lane re-runs if it's new, did not complete before, or its content changed.
  for (const s of subtasks) {
    const prev = prevById.get(s.id);
    if (prev === undefined || prev.outcome !== 'done' || prev.signature !== laneSignature(s)) {
      rerun.add(s.id);
    }
  }
  // Propagate to dependents until the rerun set is stable (transitive invalidation).
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of subtasks) {
      if (!rerun.has(s.id) && (s.dependsOn ?? []).some((d) => rerun.has(d))) {
        rerun.add(s.id);
        changed = true;
      }
    }
  }
  return {
    rerun: subtasks.filter((s) => rerun.has(s.id)),
    reusedIds: subtasks.filter((s) => !rerun.has(s.id)).map((s) => s.id),
  };
}
