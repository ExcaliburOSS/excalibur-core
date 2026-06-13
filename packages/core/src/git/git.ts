import { execFileSync } from 'node:child_process';
import { GitOperationError } from '../errors';

/**
 * Real git helpers via child_process (Build Contract §4.6). These are the
 * only places in M1 where Excalibur touches a real external tool; everything
 * is read-only except `createBranch`, which the CLI gates behind explicit
 * user intent (`excalibur branch <id>`).
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
