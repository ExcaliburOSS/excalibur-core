import { join } from 'node:path';
import { EXCALIBUR_DIR } from '../config/load-config';
import {
  addWorktree,
  applyPatch,
  checkPatchApplies,
  excludePathFromGit,
  getLocalDiff,
  getGitInfo,
  hasCommits,
  removeWorktree,
  revParse,
  stageAll,
} from '../git/git';

/**
 * Real swarm fan-out / fan-in EXECUTION (plan §"Asignación automática de
 * agentes" + M3). The deterministic {@link planAgentAllocation} decides HOW MANY
 * agents and the decomposition; THIS runs them: one isolated git worktree per
 * independent subtask (lanes never see each other's half-done files), the slow
 * agent work in PARALLEL, then a fan-in that replays each lane's diff onto a
 * merge worktree and reports any that conflict.
 *
 * The agent execution is injected as a {@link SwarmLaneRunner}, so the
 * orchestration (worktrees, parallelism, merge) is exercised deterministically
 * with real git while the real native agent loop plugs in unchanged in the CLI.
 */

/** One unit of parallel work (an independent subtask → one agent → one worktree). */
export interface SwarmLane {
  id: string;
  instruction: string;
}

/** Context handed to the lane runner: its isolated worktree + position. */
export interface SwarmLaneContext {
  lane: SwarmLane;
  worktreePath: string;
  branch: string;
  index: number;
}

/** Runs ONE lane's agent work inside its worktree, returning a lane-specific result. */
export type SwarmLaneRunner<T> = (context: SwarmLaneContext) => Promise<T>;

/** The outcome of one lane. */
export interface SwarmLaneResult<T> {
  id: string;
  index: number;
  branch: string;
  /** The lane's changes as a unified diff (working tree vs its base). */
  diff: string;
  /** Whether the lane's runner threw (its diff is still captured if any). */
  failed: boolean;
  error?: string;
  result?: T;
}

/** A lane whose diff did not apply cleanly onto the accumulating merge. */
export interface SwarmConflict {
  id: string;
  reason: string;
}

export interface SwarmResult<T> {
  lanes: SwarmLaneResult<T>[];
  /** All non-conflicting lane diffs, applied in lane order onto a merge worktree. */
  mergedDiff: string;
  /** Lanes whose diff conflicted with the merge so far (left out of mergedDiff). */
  conflicts: SwarmConflict[];
}

/** A live per-lane progress signal (for animating the swarm-lanes panel). */
export interface SwarmLaneProgress {
  index: number;
  id: string;
  /** `started` when the lane's runner begins; `settled` when it resolves/throws. */
  phase: 'started' | 'settled';
  failed?: boolean;
}

export interface RunSwarmOptions {
  /** Max lanes whose runner executes concurrently (default: all). */
  maxConcurrency?: number;
  /** Worktree base ref (default: HEAD). */
  baseRef?: string;
  /** Stable prefix for worktree dirs/branches (default: `swarm`). */
  idPrefix?: string;
  /**
   * Live per-lane progress callback — fires `started` as each lane's runner
   * begins and `settled` when it resolves or throws. The hook a live lanes
   * renderer subscribes to so the panel animates instead of only painting once
   * post-run. Best-effort: a throwing callback never breaks the swarm.
   */
  onLane?: (progress: SwarmLaneProgress) => void;
}

/** Fires a lane-progress callback, swallowing any error (never breaks the swarm). */
function emitLane(
  cb: ((p: SwarmLaneProgress) => void) | undefined,
  progress: SwarmLaneProgress,
): void {
  if (cb === undefined) return;
  try {
    cb(progress);
  } catch {
    /* a faulty progress sink must never affect the run */
  }
}

/** Runs an array of thunks with a bounded concurrency pool, preserving order. */
async function pool<R>(thunks: ReadonlyArray<() => Promise<R>>, limit: number): Promise<R[]> {
  const results = new Array<R>(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, thunks.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= thunks.length) {
        return;
      }
      results[index] = await thunks[index]!();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fans `lanes` out across isolated worktrees, runs each lane's agent work
 * (parallel, bounded), captures each diff, then fans in by replaying the diffs
 * onto a merge worktree (conflicts reported, never thrown). Every worktree is
 * always torn down. Requires a git repo with at least one commit (the base).
 */
export async function runSwarm<T>(
  repoRoot: string,
  lanes: ReadonlyArray<SwarmLane>,
  runner: SwarmLaneRunner<T>,
  options: RunSwarmOptions = {},
): Promise<SwarmResult<T>> {
  if (!getGitInfo(repoRoot).isRepo) {
    throw new Error('Swarm fan-out needs a git repository (each lane runs in an isolated worktree).');
  }
  if (!hasCommits(repoRoot)) {
    throw new Error('Swarm fan-out needs at least one commit to base each worktree on.');
  }
  if (lanes.length === 0) {
    return { lanes: [], mergedDiff: '', conflicts: [] };
  }
  const baseRef = revParse(repoRoot, options.baseRef ?? 'HEAD') ?? 'HEAD';
  const prefix = options.idPrefix ?? 'swarm';
  excludePathFromGit(repoRoot, '.excalibur/worktrees/');

  // 1. SETUP (sequential — git locks the worktree admin, so never parallel here).
  const setups = lanes.map((lane, index) => {
    const worktreePath = join(repoRoot, EXCALIBUR_DIR, 'worktrees', `${prefix}-${index}-${lane.id}`);
    const branch = `excalibur/${prefix}-${index}-${lane.id}`;
    addWorktree(repoRoot, worktreePath, { branch, baseRef });
    return { lane, index, worktreePath, branch };
  });

  try {
    // 2. RUN (parallel — the slow agent work, bounded by maxConcurrency).
    const runResults = await pool(
      setups.map((setup) => async (): Promise<{ failed: boolean; error?: string; result?: T }> => {
        emitLane(options.onLane, { index: setup.index, id: setup.lane.id, phase: 'started' });
        try {
          const result = await runner({
            lane: setup.lane,
            worktreePath: setup.worktreePath,
            branch: setup.branch,
            index: setup.index,
          });
          emitLane(options.onLane, { index: setup.index, id: setup.lane.id, phase: 'settled' });
          return { failed: false, result };
        } catch (error) {
          emitLane(options.onLane, {
            index: setup.index,
            id: setup.lane.id,
            phase: 'settled',
            failed: true,
          });
          return { failed: true, error: error instanceof Error ? error.message : String(error) };
        }
      }),
      options.maxConcurrency ?? setups.length,
    );

    // 3. CAPTURE each lane's diff (stage first so NEW files are included).
    const laneResults: SwarmLaneResult<T>[] = setups.map((setup, i) => {
      const run = runResults[i]!;
      stageAll(setup.worktreePath);
      return {
        id: setup.lane.id,
        index: setup.index,
        branch: setup.branch,
        diff: getLocalDiff(setup.worktreePath),
        failed: run.failed,
        ...(run.error !== undefined ? { error: run.error } : {}),
        ...(run.result !== undefined ? { result: run.result } : {}),
      };
    });

    // 4. FAN-IN: replay the lane diffs onto a merge worktree; report conflicts.
    const { mergedDiff, conflicts } = mergeLaneDiffs(repoRoot, baseRef, prefix, laneResults);
    return { lanes: laneResults, mergedDiff, conflicts };
  } finally {
    // 5. TEARDOWN — always remove the lane worktrees.
    for (const setup of setups) {
      removeWorktree(repoRoot, setup.worktreePath, { force: true });
    }
  }
}

/** Replays each non-empty lane diff onto a fresh merge worktree, in order. */
function mergeLaneDiffs<T>(
  repoRoot: string,
  baseRef: string,
  prefix: string,
  laneResults: ReadonlyArray<SwarmLaneResult<T>>,
): { mergedDiff: string; conflicts: SwarmConflict[] } {
  const mergePath = join(repoRoot, EXCALIBUR_DIR, 'worktrees', `${prefix}-merge`);
  const conflicts: SwarmConflict[] = [];
  addWorktree(repoRoot, mergePath, { branch: `excalibur/${prefix}-merge`, baseRef });
  try {
    for (const lane of laneResults) {
      if (lane.diff.trim().length === 0) {
        continue; // a lane that changed nothing contributes nothing
      }
      const check = checkPatchApplies(mergePath, lane.diff);
      if (!check.applies) {
        conflicts.push({ id: lane.id, reason: check.reason ?? 'did not apply onto the merge' });
        continue;
      }
      applyPatch(mergePath, lane.diff);
    }
    // Stage so newly-created files appear in the merged `git diff HEAD`.
    stageAll(mergePath);
    return { mergedDiff: getLocalDiff(mergePath), conflicts };
  } finally {
    removeWorktree(repoRoot, mergePath, { force: true });
  }
}
