import { join } from 'node:path';
import { EXCALIBUR_DIR } from '../config/load-config';
import {
  addWorktree,
  applyPatch,
  checkPatchApplies,
  commitAll,
  diffRefs,
  excludePathFromGit,
  getLocalDiff,
  getGitInfo,
  hasCommits,
  removeWorktree,
  resetWorktree,
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
  /** 1-based attempt number (>1 on a grader/throw re-dispatch). */
  attempt: number;
  /** The grader's feedback from the prior attempt — the runner folds it into the
   * prompt to REVISE its work. Absent on the first attempt (and after a throw). */
  feedback?: string;
}

/** Runs ONE lane's agent work inside its worktree, returning a lane-specific result. */
export type SwarmLaneRunner<T> = (context: SwarmLaneContext) => Promise<T>;

/** A grader's verdict on a lane's output (its diff). */
export interface SwarmGrade {
  /** Whether the lane's work meets the bar (merge it; stop revising). */
  pass: boolean;
  /** One line of actionable feedback fed back to the runner on a re-dispatch. */
  feedback?: string;
  /** Optional 0..1 score (informational). */
  score?: number;
}

/**
 * Scores a lane's output against the subtask (the rubric). When provided, a lane
 * that PASSES is kept; a lane that FAILS is RE-DISPATCHED with the feedback (the
 * revise-until-it-passes loop) up to `maxAttempts`, then marked failed. Pure
 * orchestration: the model-backed judge plugs in from the CLI.
 */
export type SwarmLaneGrader<T> = (args: {
  lane: SwarmLane;
  diff: string;
  result: T;
  attempt: number;
}) => Promise<SwarmGrade>;

/** The outcome of one lane. */
export interface SwarmLaneResult<T> {
  id: string;
  index: number;
  branch: string;
  /** The lane's changes as a unified diff (working tree vs its base). */
  diff: string;
  /** Whether the lane failed — its runner threw every attempt, OR (with a grader)
   * it never met the rubric. A failed lane is EXCLUDED from the merge. */
  failed: boolean;
  error?: string;
  result?: T;
  /** How many attempts the lane took (≥1; >1 means a grader/throw re-dispatch). */
  attempts?: number;
  /** The final grader verdict, when a grader ran. */
  grade?: SwarmGrade;
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

export interface RunSwarmOptions<T = unknown> {
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
  /**
   * Max attempts per lane (default 1 = no retry). A lane is re-dispatched in its
   * own worktree (reset to base between attempts) when its runner THROWS (a
   * transient model/network error), OR — with a {@link grade} — when its output
   * fails the rubric. A lane that succeeds AND passes the grader is never
   * retried.
   */
  maxAttempts?: number;
  /**
   * Optional grader: scores each lane's diff against its subtask. A failing lane
   * is RE-DISPATCHED with the grader's feedback (the revise-until-it-passes loop)
   * until it passes or `maxAttempts` is hit; an exhausted lane is marked failed.
   * Off by default (throw-based retry only).
   */
  grade?: SwarmLaneGrader<T>;
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

/** A lane's worktree, assigned during setup. */
interface LaneSetup {
  lane: SwarmLane;
  index: number;
  worktreePath: string;
  branch: string;
}

/** The result of running one lane (before its diff is captured). */
interface LaneRun<T> {
  failed: boolean;
  error?: string;
  result?: T;
  attempts: number;
  grade?: SwarmGrade;
}

/**
 * Runs ONE lane's agent work in its worktree with the retry/grade loop: on a
 * THROW (transient error) or a grader FAIL it resets the worktree to `baseRef`
 * and re-dispatches with feedback, up to `maxAttempts`. Shared by the flat
 * {@link runSwarm} and the staged {@link runSwarmStaged} executors so both have
 * identical lane semantics. `baseRef` is the ref the lane's worktree was created
 * at (HEAD for flat; the prior wave's merged commit for a staged dependent wave).
 */
async function runOneLane<T>(
  setup: LaneSetup,
  runner: SwarmLaneRunner<T>,
  options: RunSwarmOptions<T>,
  baseRef: string,
): Promise<LaneRun<T>> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  let lastError = '';
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Before a RE-DISPATCH, restore the lane's worktree to pristine base so a
    // prior attempt's edits never contaminate this attempt's diff.
    if (attempt > 1) {
      resetWorktree(setup.worktreePath, baseRef);
    }
    emitLane(options.onLane, { index: setup.index, id: setup.lane.id, phase: 'started' });
    try {
      const result = await runner({
        lane: setup.lane,
        worktreePath: setup.worktreePath,
        branch: setup.branch,
        index: setup.index,
        attempt,
        ...(feedback !== undefined ? { feedback } : {}),
      });
      // GRADE (when set): score this attempt's diff; a fail re-dispatches with
      // feedback (revise loop) until it passes or attempts exhaust.
      if (options.grade !== undefined) {
        stageAll(setup.worktreePath);
        const diff = getLocalDiff(setup.worktreePath);
        const grade = await options.grade({ lane: setup.lane, diff, result, attempt });
        if (!grade.pass) {
          lastError = grade.feedback ?? 'did not meet the rubric';
          feedback = grade.feedback;
          if (attempt < maxAttempts) {
            continue; // revise
          }
          emitLane(options.onLane, {
            index: setup.index,
            id: setup.lane.id,
            phase: 'settled',
            failed: true,
          });
          return { failed: true, error: `rubric not met: ${lastError}`, attempts: attempt, grade };
        }
        emitLane(options.onLane, { index: setup.index, id: setup.lane.id, phase: 'settled' });
        return { failed: false, result, attempts: attempt, grade };
      }
      emitLane(options.onLane, { index: setup.index, id: setup.lane.id, phase: 'settled' });
      return { failed: false, result, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      feedback = undefined; // a thrown attempt yields no grader feedback
      // Re-dispatch on a non-final attempt.
    }
  }
  emitLane(options.onLane, {
    index: setup.index,
    id: setup.lane.id,
    phase: 'settled',
    failed: true,
  });
  return { failed: true, error: lastError, attempts: maxAttempts };
}

/** Stages a lane's worktree and captures its diff into a {@link SwarmLaneResult}. */
function captureLane<T>(setup: LaneSetup, run: LaneRun<T>): SwarmLaneResult<T> {
  stageAll(setup.worktreePath);
  return {
    id: setup.lane.id,
    index: setup.index,
    branch: setup.branch,
    diff: getLocalDiff(setup.worktreePath),
    failed: run.failed,
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.result !== undefined ? { result: run.result } : {}),
    ...(run.attempts !== undefined ? { attempts: run.attempts } : {}),
    ...(run.grade !== undefined ? { grade: run.grade } : {}),
  };
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
  options: RunSwarmOptions<T> = {},
): Promise<SwarmResult<T>> {
  if (!getGitInfo(repoRoot).isRepo) {
    throw new Error(
      'Swarm fan-out needs a git repository (each lane runs in an isolated worktree).',
    );
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
    const worktreePath = join(
      repoRoot,
      EXCALIBUR_DIR,
      'worktrees',
      `${prefix}-${index}-${lane.id}`,
    );
    const branch = `excalibur/${prefix}-${index}-${lane.id}`;
    addWorktree(repoRoot, worktreePath, { branch, baseRef });
    return { lane, index, worktreePath, branch };
  });

  try {
    // 2. RUN (parallel — the slow agent work, bounded by maxConcurrency).
    const runResults = await pool(
      setups.map((setup) => () => runOneLane(setup, runner, options, baseRef)),
      options.maxConcurrency ?? setups.length,
    );

    // 3. CAPTURE each lane's diff (stage first so NEW files are included).
    const laneResults = setups.map((setup, i) => captureLane(setup, runResults[i]!));

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

/**
 * STAGED fan-out / fan-in (AO3c) — the real A→{B,C}→D dependency graph. Runs the
 * dependency WAVES in order: each wave's lanes execute in parallel (bounded)
 * against a base that already contains the MERGED result of every prior wave, so
 * a dependent lane SEES its predecessors' work. After each wave its lane diffs
 * are merged onto an accumulating merge worktree, which is COMMITTED so the next
 * wave can base on it. The final `mergedDiff` is the whole accumulation vs the
 * original base. Lane semantics (retry/grade/onLane/teardown) are identical to
 * the flat {@link runSwarm}; this just sequences waves and rebases between them.
 *
 * `waves` is the topological levelization (see `topologicalWaves`): `waves[0]`
 * are the independent lanes, `waves[1]` depend only on `waves[0]`, etc. A flat
 * task is simply a single wave — callers fall back to {@link runSwarm} for that.
 */
export async function runSwarmStaged<T>(
  repoRoot: string,
  waves: ReadonlyArray<ReadonlyArray<SwarmLane>>,
  runner: SwarmLaneRunner<T>,
  options: RunSwarmOptions<T> = {},
): Promise<SwarmResult<T>> {
  if (!getGitInfo(repoRoot).isRepo) {
    throw new Error(
      'Swarm fan-out needs a git repository (each lane runs in an isolated worktree).',
    );
  }
  if (!hasCommits(repoRoot)) {
    throw new Error('Swarm fan-out needs at least one commit to base each worktree on.');
  }
  const nonEmptyWaves = waves.filter((w) => w.length > 0);
  if (nonEmptyWaves.length === 0) {
    return { lanes: [], mergedDiff: '', conflicts: [] };
  }
  const baseRef = revParse(repoRoot, options.baseRef ?? 'HEAD') ?? 'HEAD';
  const prefix = options.idPrefix ?? 'swarm';
  excludePathFromGit(repoRoot, '.excalibur/worktrees/');

  // The accumulating merge worktree persists across ALL waves; each wave is
  // committed onto it so the next wave can base on the merged result.
  const mergePath = join(repoRoot, EXCALIBUR_DIR, 'worktrees', `${prefix}-merge`);
  addWorktree(repoRoot, mergePath, { branch: `excalibur/${prefix}-merge`, baseRef });

  const allLaneResults: SwarmLaneResult<T>[] = [];
  const conflicts: SwarmConflict[] = [];
  let currentBaseRef = baseRef;
  let globalIndex = 0;

  try {
    for (const wave of nonEmptyWaves) {
      // 1. SETUP this wave's lane worktrees at the predecessors-merged base.
      const setups: LaneSetup[] = wave.map((lane) => {
        const index = globalIndex++;
        const worktreePath = join(
          repoRoot,
          EXCALIBUR_DIR,
          'worktrees',
          `${prefix}-${index}-${lane.id}`,
        );
        const branch = `excalibur/${prefix}-${index}-${lane.id}`;
        addWorktree(repoRoot, worktreePath, { branch, baseRef: currentBaseRef });
        return { lane, index, worktreePath, branch };
      });
      try {
        // 2. RUN this wave (parallel, bounded), basing retries on the wave base.
        const runResults = await pool(
          setups.map((setup) => () => runOneLane(setup, runner, options, currentBaseRef)),
          options.maxConcurrency ?? setups.length,
        );
        const laneResults = setups.map((setup, i) => captureLane(setup, runResults[i]!));
        allLaneResults.push(...laneResults);

        // 3. MERGE this wave onto the accumulating worktree (at currentBaseRef),
        //    3-way healing a texturally-conflicting lane before giving up (AO4d).
        for (const lane of laneResults) {
          if (lane.failed || lane.diff.trim().length === 0) {
            continue;
          }
          if (!mergeOneLane(mergePath, lane.diff)) {
            conflicts.push({ id: lane.id, reason: 'did not apply onto the merge (even 3-way)' });
          }
        }

        // 4. COMMIT the wave so the NEXT wave bases on predecessors' merged work.
        //    (A no-op commit when the wave changed nothing leaves HEAD as-is.)
        stageAll(mergePath);
        commitAll(mergePath, `excalibur swarm wave: ${wave.map((l) => l.id).join(', ')}`);
        currentBaseRef = revParse(mergePath, 'HEAD') ?? currentBaseRef;
      } finally {
        // 5. TEARDOWN this wave's lane worktrees (wave-scoped — free disk early).
        for (const setup of setups) {
          removeWorktree(repoRoot, setup.worktreePath, { force: true });
        }
      }
    }

    // FINAL: the whole accumulation vs the original base (every wave committed).
    const mergedDiff = diffRefs(mergePath, baseRef, 'HEAD');
    return { lanes: allLaneResults, mergedDiff, conflicts };
  } finally {
    removeWorktree(repoRoot, mergePath, { force: true });
  }
}

/**
 * Merges ONE lane's diff onto the merge worktree (AO4d conflict-as-heal). Tries a
 * clean apply; on conflict retries with a 3-way merge — recovering a lane that
 * only conflicts texturally (overlapping context on an existing file) instead of
 * silently dropping its work. Returns false only when even the 3-way fails (a
 * genuine same-line conflict). Empty diffs are a no-op success.
 */
function mergeOneLane(mergePath: string, diff: string): boolean {
  if (diff.trim().length === 0) return true;
  if (checkPatchApplies(mergePath, diff).applies) {
    applyPatch(mergePath, diff);
    // Stage so the index tracks the working tree — `git apply --3way` for a LATER
    // lane requires the file to match the index, or it errors "does not match
    // index" and the heal silently no-ops.
    stageAll(mergePath);
    return true;
  }
  try {
    applyPatch(mergePath, diff, { threeway: true });
    stageAll(mergePath);
    return true;
  } catch {
    return false;
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
      if (lane.failed || lane.diff.trim().length === 0) {
        continue; // a failed lane (threw all attempts / never met the rubric) or
        // one that changed nothing contributes no work to the merge.
      }
      if (!mergeOneLane(mergePath, lane.diff)) {
        conflicts.push({ id: lane.id, reason: 'did not apply onto the merge (even 3-way)' });
      }
    }
    // Stage so newly-created files appear in the merged `git diff HEAD`.
    stageAll(mergePath);
    return { mergedDiff: getLocalDiff(mergePath), conflicts };
  } finally {
    removeWorktree(repoRoot, mergePath, { force: true });
  }
}
