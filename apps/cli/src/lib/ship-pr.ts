import { execFileSync } from 'node:child_process';
import { isCommandOnPath } from '@excalibur/agent-runtime';
import { commitAll, type GitInfo } from '@excalibur/core';

/**
 * The mission `ship` capability's mechanical half (M8 follow-up): commit the
 * completed work and — when the user opted in (`--pr`) and a `gh` remote is
 * reachable — open a real pull request for it. The agentic ship turn writes the
 * PR title/body; THIS does the git + GitHub plumbing, degrading gracefully at
 * every step so a missing `gh`, no remote, or a push/PR failure never fails the
 * mission (the local commit is the floor; the PR is the bonus).
 *
 * Opening a PR pushes a branch to a remote — an outward-facing action — so it is
 * gated behind explicit `openPr` intent, never done autonomously by default.
 */

/** Runs a command, capturing success + output. Injectable so the flow is testable. */
export type CommandRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => { ok: boolean; stdout: string; stderr: string };

export interface ShipDeps {
  /** Command runner (git/gh). Defaults to a real `execFileSync` runner. */
  run?: CommandRunner;
  /** Whether the GitHub CLI is available. Defaults to `isCommandOnPath('gh')`. */
  ghAvailable?: boolean;
  /** Commits the working tree (returns false when there was nothing to commit).
   * Injectable so the flow is testable without touching a real repo. */
  commit?: (repoRoot: string, message: string) => boolean;
}

export interface ShipInput {
  /** The mission goal — the source of the PR title + commit message. */
  goal: string;
  /** The PR body (the agentic ship turn's summary); falls back to the title. */
  body: string;
  /** Whether to open a PR (explicit `--pr` intent). When false → commit only. */
  openPr: boolean;
  /** The repo's git info (passed in so the core stays a pure decision + injected I/O). */
  gitInfo: GitInfo;
}

export interface ShipOutcome {
  committed: boolean;
  /** The branch the work landed on (a feature branch when a PR was opened). */
  branch?: string;
  /** The opened PR URL, when one was created. */
  prUrl?: string;
  /** A human one-line summary of what shipping did (shown in the rail + reassessor). */
  note: string;
}

const realRunner: CommandRunner = (cmd, args, cwd) => {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : String(error),
    };
  }
};

/** The PR title from a goal: a single trimmed line, capped (gh rejects very long titles). */
export function prTitle(goal: string): string {
  const clean = goal.replace(/\s+/g, ' ').trim().slice(0, 72);
  return clean.length > 0 ? clean : 'Excalibur changes';
}

/** A git-safe feature-branch name derived from the goal. */
export function prBranchName(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `excalibur/${slug.length > 0 ? slug : 'mission'}`;
}

/** The repo's default branch via the remote HEAD ref (`origin/main` → `main`); 'main' fallback. */
function defaultBranch(run: CommandRunner, repoRoot: string): string {
  const res = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot);
  if (res.ok) {
    const name = res.stdout.trim().replace(/^origin\//, '');
    if (name.length > 0) return name;
  }
  return 'main';
}

/** The last non-empty stdout line (gh prints the PR URL there on success). */
function lastLine(stdout: string): string {
  return (
    stdout
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .pop() ?? ''
  );
}

/** Trims a git/gh error to a short, single-line reason for the note. */
function short(stderr: string): string {
  return stderr.replace(/\s+/g, ' ').trim().slice(0, 120) || 'unknown error';
}

function committedNote(branch?: string): string {
  return branch !== undefined ? `Committed the change on ${branch}.` : 'Committed the change.';
}

/**
 * Commits the working tree and, when `openPr` is set and a `gh` remote is
 * reachable, opens a PR for it (moving onto a feature branch first if we are on
 * the default branch). Pure decision + injected I/O — never throws.
 */
export function shipChange(repoRoot: string, input: ShipInput, deps: ShipDeps = {}): ShipOutcome {
  const run = deps.run ?? realRunner;
  const ghAvailable = deps.ghAvailable ?? isCommandOnPath('gh', process.env);
  const commit = deps.commit ?? commitAll;
  const { goal, body, openPr, gitInfo } = input;
  const title = prTitle(goal);
  const message = `Excalibur: ${title}`;

  // A PR is possible only with explicit intent + a real GitHub remote + the CLI.
  const canPr = openPr && ghAvailable && gitInfo.isRepo && gitInfo.remoteUrl !== null;

  // The branch the PR work lands on — set ONLY when shipping a PR (a plain local
  // commit just lands on the current branch and is not echoed back).
  let branch: string | undefined;
  let base = 'main';
  if (canPr) {
    base = defaultBranch(run, repoRoot);
    // Get off the default branch FIRST (you cannot PR a branch against itself) —
    // create/switch the feature branch BEFORE committing so the work lands on it
    // and the default branch stays clean.
    if (gitInfo.branch === null || gitInfo.branch === base) {
      const feature = prBranchName(goal);
      if (run('git', ['checkout', '-b', feature], repoRoot).ok) branch = feature;
      else if (run('git', ['checkout', feature], repoRoot).ok) branch = feature; // already exists
    } else {
      branch = gitInfo.branch; // already on a feature branch
    }
  }

  const committed = commit(repoRoot, message);

  if (!canPr || branch === undefined) {
    const note = !committed
      ? 'Nothing to commit.'
      : openPr
        ? 'Committed the change. (PR skipped — needs the gh CLI + a GitHub remote.)'
        : 'Committed the change.';
    return { committed, note };
  }

  // Push the branch + open the PR; degrade to the commit on any failure.
  const push = run('git', ['push', '-u', 'origin', branch], repoRoot);
  if (!push.ok) {
    return {
      committed,
      branch,
      note: `${committedNote(branch)} Push failed (${short(push.stderr)}) — open the PR manually.`,
    };
  }
  const pr = run(
    'gh',
    [
      'pr',
      'create',
      '--title',
      title,
      '--body',
      body.trim().length > 0 ? body : title,
      '--head',
      branch,
      '--base',
      base,
    ],
    repoRoot,
  );
  if (!pr.ok) {
    return {
      committed,
      branch,
      note: `${committedNote(branch)} Pushed, but the PR was not created (${short(pr.stderr)}).`,
    };
  }
  const url = lastLine(pr.stdout);
  return {
    committed,
    branch,
    ...(url.length > 0 ? { prUrl: url } : {}),
    note: url.length > 0 ? `Opened a pull request: ${url}` : 'Opened a pull request.',
  };
}
