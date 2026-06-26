import { describe, expect, it } from 'vitest';
import type { GitInfo } from '@excalibur/core';
import { prBranchName, prTitle, shipChange, type CommandRunner, type ShipDeps } from './ship-pr';

const REPO = '/repo';

function gitInfo(over: Partial<GitInfo> = {}): GitInfo {
  return { isRepo: true, branch: 'main', remoteUrl: 'git@github.com:o/r.git', ...over };
}

/** A scripted runner: maps a command key to a result; records the calls made. */
function runner(
  script: Record<string, { ok: boolean; stdout?: string; stderr?: string }>,
): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = (cmd, args, _cwd) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    // Match the most specific scripted prefix.
    const hit = Object.keys(script)
      .filter((k) => key.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const res = hit !== undefined ? script[hit]! : { ok: true, stdout: '', stderr: '' };
    return { ok: res.ok, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  };
  return Object.assign(run, { calls });
}

function deps(
  run: CommandRunner,
  committed = true,
  ghAvailable = true,
): ShipDeps & { commits: string[] } {
  const commits: string[] = [];
  return {
    run,
    ghAvailable,
    commit: (_repo, message) => {
      commits.push(message);
      return committed;
    },
    commits,
  };
}

describe('prTitle / prBranchName', () => {
  it('makes a single capped title and a git-safe branch', () => {
    expect(prTitle('  add   OAuth\nlogin ')).toBe('add OAuth login');
    expect(prTitle('')).toBe('Excalibur changes');
    expect(prTitle('x'.repeat(200))).toHaveLength(72);
    expect(prBranchName('Add OAuth login!! to the API')).toBe(
      'excalibur/add-oauth-login-to-the-api',
    );
    expect(prBranchName('***')).toBe('excalibur/mission');
  });
});

describe('shipChange', () => {
  it('commits only (no branch/push/PR) when openPr is false', () => {
    const run = runner({});
    const d = deps(run);
    const out = shipChange(
      REPO,
      { goal: 'do a thing', body: '', openPr: false, gitInfo: gitInfo() },
      d,
    );
    expect(out).toMatchObject({ committed: true, note: 'Committed the change.' });
    expect(out.prUrl).toBeUndefined();
    expect(run.calls).toEqual([]); // no git/gh ran
    expect(d.commits).toEqual(['Excalibur: do a thing']);
  });

  it('on the default branch: creates a feature branch, pushes, opens the PR', () => {
    const run = runner({
      'git symbolic-ref': { ok: true, stdout: 'origin/main\n' },
      'git checkout -b excalibur/add-rate-limiting': { ok: true },
      'git push': { ok: true },
      'gh pr create': { ok: true, stdout: 'https://github.com/o/r/pull/7\n' },
    });
    const out = shipChange(
      REPO,
      {
        goal: 'add rate limiting',
        body: 'Adds a token-bucket limiter.',
        openPr: true,
        gitInfo: gitInfo(),
      },
      deps(run),
    );
    expect(out).toMatchObject({
      committed: true,
      branch: 'excalibur/add-rate-limiting',
      prUrl: 'https://github.com/o/r/pull/7',
    });
    expect(out.note).toContain('https://github.com/o/r/pull/7');
    expect(run.calls).toContain('git checkout -b excalibur/add-rate-limiting');
    expect(run.calls).toContain('git push -u origin excalibur/add-rate-limiting');
    expect(run.calls.some((c) => c.startsWith('gh pr create'))).toBe(true);
  });

  it('already on a feature branch: keeps it, no new branch', () => {
    const run = runner({
      'git symbolic-ref': { ok: true, stdout: 'origin/main\n' },
      'git push': { ok: true },
      'gh pr create': { ok: true, stdout: 'https://github.com/o/r/pull/9' },
    });
    const out = shipChange(
      REPO,
      { goal: 'fix bug', body: 'fix', openPr: true, gitInfo: gitInfo({ branch: 'feature/x' }) },
      deps(run),
    );
    expect(out.branch).toBe('feature/x');
    expect(out.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(run.calls.some((c) => c.startsWith('git checkout'))).toBe(false);
  });

  it('degrades to the commit when gh is unavailable (still ok, notes why)', () => {
    const run = runner({});
    const out = shipChange(
      REPO,
      { goal: 'do it', body: '', openPr: true, gitInfo: gitInfo() },
      deps(run, true, /* ghAvailable */ false),
    );
    expect(out).toMatchObject({ committed: true });
    expect(out.prUrl).toBeUndefined();
    expect(out.note).toContain('PR skipped');
    expect(run.calls).toEqual([]);
  });

  it('degrades when there is no remote', () => {
    const run = runner({});
    const out = shipChange(
      REPO,
      { goal: 'do it', body: '', openPr: true, gitInfo: gitInfo({ remoteUrl: null }) },
      deps(run),
    );
    expect(out.prUrl).toBeUndefined();
    expect(out.note).toContain('PR skipped');
  });

  it('commits + reports when the push fails (no PR attempted)', () => {
    const run = runner({
      'git symbolic-ref': { ok: true, stdout: 'origin/main' },
      'git checkout -b': { ok: true },
      'git push': { ok: false, stderr: 'permission denied' },
    });
    const out = shipChange(
      REPO,
      { goal: 'thing', body: '', openPr: true, gitInfo: gitInfo() },
      deps(run),
    );
    expect(out.committed).toBe(true);
    expect(out.prUrl).toBeUndefined();
    expect(out.note).toContain('Push failed');
    expect(run.calls.some((c) => c.startsWith('gh pr create'))).toBe(false);
  });

  it('commits + pushes but reports when gh pr create fails', () => {
    const run = runner({
      'git symbolic-ref': { ok: true, stdout: 'origin/main' },
      'git checkout -b': { ok: true },
      'git push': { ok: true },
      'gh pr create': { ok: false, stderr: 'a pull request already exists' },
    });
    const out = shipChange(
      REPO,
      { goal: 'thing', body: '', openPr: true, gitInfo: gitInfo() },
      deps(run),
    );
    expect(out.prUrl).toBeUndefined();
    expect(out.note).toContain('not created');
  });

  it('falls back to the title as the PR body when the summary is empty', () => {
    const run = runner({
      'git symbolic-ref': { ok: true, stdout: 'origin/main' },
      'git checkout -b': { ok: true },
      'git push': { ok: true },
      'gh pr create': { ok: true, stdout: 'https://github.com/o/r/pull/1' },
    });
    shipChange(REPO, { goal: 'my goal', body: '   ', openPr: true, gitInfo: gitInfo() }, deps(run));
    const prCall = run.calls.find((c) => c.startsWith('gh pr create'))!;
    expect(prCall).toContain('--body my goal');
  });
});
