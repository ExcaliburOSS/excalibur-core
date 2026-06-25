import { execFileSync } from 'node:child_process';
import type { CliDeps } from '../deps';

/**
 * Recoverability for AUTONOMOUS runs (the launch-review safety gap: a `--yes`/
 * mission run mutates the real working tree, and a mid-run failure used to leave
 * it dirty with no rollback). This does NOT change where the run writes — it makes
 * a failure recoverable and nudges the user to a clean start:
 *
 *  - {@link warnDirtyTree} — before an autonomous run, suggest committing/stashing
 *    so the agent's changes are cleanly reviewable + revertible.
 *  - {@link captureRestorePoint} — record HEAD and snapshot any pre-run uncommitted
 *    changes into a DANGLING commit (via `git stash create`, which never touches the
 *    tree), so nothing is lost even if the run crashes.
 *  - {@link printRecoveryHint} — on a failed/aborted/paused outcome, tell the user
 *    exactly how to roll back.
 *
 * All git calls are best-effort: a non-git directory or a git failure degrades to a
 * no-op (the run proceeds), never an error.
 */

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export interface RestorePoint {
  /** HEAD commit at the start of the run (null outside a git repo). */
  head: string | null;
  /** A dangling commit capturing pre-run uncommitted changes, or null if clean. */
  snapshot: string | null;
  /** Whether the tree already had uncommitted changes when the run started. */
  wasDirty: boolean;
}

/** True when the working tree has uncommitted changes. */
export function isDirty(repoRoot: string): boolean {
  const status = git(repoRoot, ['status', '--porcelain']);
  return status !== null && status.length > 0;
}

/** Warns (non-blocking) when starting an autonomous run on a dirty tree. */
export function warnDirtyTree(deps: CliDeps, repoRoot: string): void {
  if (isDirty(repoRoot)) {
    deps.ui.warn(
      'Working tree has uncommitted changes — commit or stash first so you can cleanly review and revert what Excalibur does.',
    );
  }
}

/** Captures a restore point: HEAD + a dangling snapshot of any uncommitted state. */
export function captureRestorePoint(repoRoot: string): RestorePoint {
  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  const wasDirty = isDirty(repoRoot);
  // `git stash create` writes a commit object WITHOUT modifying the working tree
  // (returns empty on a clean tree).
  const snap = wasDirty ? git(repoRoot, ['stash', 'create']) : null;
  return { head, snapshot: snap !== null && snap.length > 0 ? snap : null, wasDirty };
}

/** On a non-completed outcome, prints exactly how to roll the run back. */
export function printRecoveryHint(deps: CliDeps, point: RestorePoint): void {
  if (point.head === null) {
    return; // not a git repo — nothing to roll back to
  }
  const head = point.head.slice(0, 12);
  const lines: string[] = [
    `Restore point: discard everything from this run with  git reset --hard ${head} && git clean -fd` +
      (point.wasDirty ? '  (this also drops the changes you had before the run)' : ''),
  ];
  if (point.snapshot !== null) {
    lines.push(
      `Your pre-run uncommitted changes are snapshotted — recover them with  git stash apply ${point.snapshot.slice(0, 12)}`,
    );
  }
  deps.ui.info(lines.join('\n'));
}
