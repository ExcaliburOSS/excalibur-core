import { execFileSync } from 'node:child_process';
import { GitOperationError } from '../errors';

/**
 * Real git helpers via child_process (Build Contract §4.6). Read-only by
 * default; the mutating helpers (`createBranch`, `applyPatch`) are gated by
 * the CLI behind explicit user intent (`excalibur branch <id>` / `apply`).
 *
 * Patch validation/application (`checkPatchApplies`, `applyPatch`) stream the
 * diff to git over STDIN and rely on git's own path safety: `git apply`
 * refuses paths that escape the work tree (`..` traversal, absolute paths)
 * unless `--unsafe-paths` is passed — which we never pass.
 */

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  remoteUrl: string | null;
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/** Runs git and returns trimmed stdout, or `null` on any failure. */
function tryGit(repoRoot: string, args: string[]): string | null {
  try {
    const stdout = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Repository detection plus current branch and origin URL. */
export function getGitInfo(repoRoot: string): GitInfo {
  const inside = tryGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return { isRepo: false, branch: null, remoteUrl: null };
  }
  const branch = tryGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const remoteUrl = tryGit(repoRoot, ['remote', 'get-url', 'origin']);
  return {
    isRepo: true,
    branch: branch !== null && branch.length > 0 ? branch : null,
    remoteUrl: remoteUrl !== null && remoteUrl.length > 0 ? remoteUrl : null,
  };
}

/** Local git identity (`user.name` / `user.email`), `null` when unset. */
export interface GitIdentity {
  name: string | null;
  email: string | null;
}

/**
 * Reads the configured git identity (`git config user.name` / `user.email`).
 * Used cosmetically (e.g. the M-Shell welcome's "Welcome back, …"); both fields
 * are `null` outside a configured repo.
 */
export function getGitIdentity(repoRoot: string): GitIdentity {
  const name = tryGit(repoRoot, ['config', 'user.name']);
  const email = tryGit(repoRoot, ['config', 'user.email']);
  return {
    name: name !== null && name.length > 0 ? name : null,
    email: email !== null && email.length > 0 ? email : null,
  };
}

/**
 * The local uncommitted diff. Prefers `git diff HEAD` (staged + unstaged);
 * falls back to `git diff` in repositories without commits. Returns an empty
 * string when there is no diff or the directory is not a git repository.
 */
export function getLocalDiff(repoRoot: string): string {
  const againstHead = tryGit(repoRoot, ['diff', 'HEAD']);
  if (againstHead !== null) {
    return againstHead.length > 0 ? `${againstHead}\n` : '';
  }
  const workingTree = tryGit(repoRoot, ['diff']);
  if (workingTree !== null) {
    return workingTree.length > 0 ? `${workingTree}\n` : '';
  }
  return '';
}

/**
 * Creates and checks out a new branch.
 *
 * @throws GitOperationError when git fails (not a repo, branch exists, …).
 */
export function createBranch(repoRoot: string, name: string): void {
  try {
    execFileSync('git', ['checkout', '-b', name], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new GitOperationError(`Cannot create branch "${name}" in ${repoRoot}: ${reason}`, {
      repoRoot,
      branch: name,
    });
  }
}

/** Resolves a ref to a full commit SHA (`git rev-parse`), or null when unknown. */
export function revParse(repoRoot: string, ref: string): string | null {
  return tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
}

/**
 * Stages everything and commits it (`--no-gpg-sign` so a signing config never
 * hangs/fails headless). Tolerant: returns false on any failure (no identity,
 * nothing to commit, …) rather than throwing — callers use it best-effort.
 */
export function commitAll(repoRoot: string, message: string): boolean {
  if (tryGit(repoRoot, ['add', '-A']) === null) {
    return false;
  }
  return tryGit(repoRoot, ['commit', '--no-gpg-sign', '-m', message]) !== null;
}

/** True when the repository has at least one commit (a valid HEAD). */
export function hasCommits(repoRoot: string): boolean {
  return revParse(repoRoot, 'HEAD') !== null;
}

/**
 * Creates a new git worktree at `worktreePath` on a NEW branch `branch`, based
 * at `baseRef` (defaults to HEAD). Used by the time-machine fork to reconstruct
 * a run's state in an isolated tree without touching the user's working copy.
 *
 * @throws GitOperationError when git refuses (no commits, branch/path exists, …).
 */
export function addWorktree(
  repoRoot: string,
  worktreePath: string,
  opts: { branch: string; baseRef?: string },
): void {
  const base = opts.baseRef ?? 'HEAD';
  try {
    execFileSync('git', ['worktree', 'add', '-b', opts.branch, worktreePath, base], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const reason = stderrReason(error);
    throw new GitOperationError(
      `Cannot create worktree at "${worktreePath}" (branch "${opts.branch}", base "${base}"): ${reason.length > 0 ? reason : 'git worktree add failed'}`,
      { repoRoot, worktreePath, branch: opts.branch },
    );
  }
}

/**
 * Removes a git worktree (and prunes its admin entry). `force` discards any
 * uncommitted changes in the worktree. Tolerant: never throws — a best-effort
 * cleanup must not mask the original outcome. Returns whether removal succeeded.
 */
export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  opts?: { force?: boolean },
): boolean {
  const args = ['worktree', 'remove'];
  if (opts?.force === true) {
    args.push('--force');
  }
  args.push(worktreePath);
  const removed = tryGit(repoRoot, args) !== null;
  // Prune stale admin entries regardless (e.g. if the dir was already gone).
  tryGit(repoRoot, ['worktree', 'prune']);
  return removed;
}

/** Ensures a unified diff ends with exactly one trailing newline (git apply requires it). */
function withTrailingNewline(diff: string): string {
  return diff.endsWith('\n') ? diff : `${diff}\n`;
}

/** Trims a child-process stderr Buffer/string to a single useful reason line. */
function stderrReason(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string } | undefined)?.stderr;
  const text =
    stderr !== undefined && stderr !== null
      ? stderr.toString()
      : error instanceof Error
        ? error.message
        : String(error);
  return text.trim();
}

/**
 * Validates a unified diff against the working tree with `git apply --check`
 * (no files are modified). An invalid or non-applying diff is a normal
 * outcome, so this NEVER throws — it returns the failure as data.
 *
 * Security: we never pass `--unsafe-paths`, so git refuses diffs touching
 * paths outside the repository (`..` traversal, absolute paths).
 */
export function checkPatchApplies(
  repoRoot: string,
  diff: string,
  opts?: { reverse?: boolean },
): { applies: boolean; reason: string | null } {
  if (diff.trim().length === 0) {
    return { applies: false, reason: 'empty diff' };
  }
  const args = ['apply', '--check'];
  if (opts?.reverse === true) {
    args.push('-R');
  }
  args.push('-');
  try {
    execFileSync('git', args, {
      cwd: repoRoot,
      input: withTrailingNewline(diff),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { applies: true, reason: null };
  } catch (error) {
    const reason = stderrReason(error);
    return { applies: false, reason: reason.length > 0 ? reason : 'git apply --check failed' };
  }
}

/**
 * Applies a unified diff to the working tree via `git apply` (reading the diff
 * from STDIN). With `opts.threeway` it falls back to a 3-way merge using blob
 * info recorded in the diff.
 *
 * Security: we never pass `--unsafe-paths`, so git refuses diffs touching
 * paths outside the repository (`..` traversal, absolute paths).
 *
 * @throws GitOperationError on an empty diff or when git refuses the patch.
 */
export function applyPatch(
  repoRoot: string,
  diff: string,
  opts?: { threeway?: boolean; reverse?: boolean },
): void {
  if (diff.trim().length === 0) {
    throw new GitOperationError(`Cannot apply an empty diff in ${repoRoot}.`, {
      repoRoot,
      reason: 'empty diff',
    });
  }
  const args = ['apply'];
  if (opts?.threeway === true) {
    args.push('--3way');
  }
  if (opts?.reverse === true) {
    args.push('-R');
  }
  args.push('-');
  try {
    execFileSync('git', args, {
      cwd: repoRoot,
      input: withTrailingNewline(diff),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const reason = stderrReason(error);
    throw new GitOperationError(
      `git apply failed in ${repoRoot}: ${reason.length > 0 ? reason : 'patch did not apply'}`,
      { repoRoot, reason },
    );
  }
}

/** Field separator for the git log format (unit separator, never in text). */
const LOG_SEPARATOR = '';

/** Commits since `sinceIso` (ISO-8601), newest first. Empty when not a repo. */
export function listRecentCommits(repoRoot: string, sinceIso: string): GitCommit[] {
  const output = tryGit(repoRoot, [
    'log',
    `--since=${sinceIso}`,
    `--pretty=format:%H${LOG_SEPARATOR}%s${LOG_SEPARATOR}%an${LOG_SEPARATOR}%cI`,
  ]);
  if (output === null || output.length === 0) {
    return [];
  }
  const commits: GitCommit[] = [];
  for (const line of output.split('\n')) {
    const [hash, subject, author, date] = line.split(LOG_SEPARATOR);
    if (hash !== undefined && subject !== undefined && author !== undefined && date !== undefined) {
      commits.push({ hash, subject, author, date });
    }
  }
  return commits;
}
