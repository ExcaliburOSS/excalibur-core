import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitOperationError } from '../errors';
import { git, initGitRepo, makeTempDir, removeDir } from '../test-utils';
import { createBranch, getGitInfo, getLocalDiff, listRecentCommits } from './git';

describe('git helpers', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('reports non-repositories honestly', () => {
    expect(getGitInfo(repoRoot)).toEqual({ isRepo: false, branch: null, remoteUrl: null });
    expect(getLocalDiff(repoRoot)).toBe('');
    expect(listRecentCommits(repoRoot, new Date(0).toISOString())).toEqual([]);
  });

  it('reads repo info, local diff and recent commits from a real repository', () => {
    initGitRepo(repoRoot);

    const info = getGitInfo(repoRoot);
    expect(info.isRepo).toBe(true);
    expect(info.branch).toBe('main');
    expect(info.remoteUrl).toBeNull();

    expect(getLocalDiff(repoRoot)).toBe('');
    writeFileSync(join(repoRoot, 'README.md'), '# Test repo\n\nChanged.\n', 'utf8');
    const diff = getLocalDiff(repoRoot);
    expect(diff).toContain('--- a/README.md');
    expect(diff).toContain('+Changed.');

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const commits = listRecentCommits(repoRoot, since);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ subject: 'initial commit', author: 'Excalibur Test' });
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('creates and checks out a new branch', () => {
    initGitRepo(repoRoot);
    createBranch(repoRoot, 'excalibur/patch_20260613_120000');
    expect(git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
      'excalibur/patch_20260613_120000',
    );
  });

  it('throws GitOperationError when branch creation fails', () => {
    expect(() => createBranch(repoRoot, 'feature/x')).toThrowError(GitOperationError);
    initGitRepo(repoRoot);
    createBranch(repoRoot, 'dup');
    git(repoRoot, ['checkout', 'main']);
    expect(() => createBranch(repoRoot, 'dup')).toThrowError(GitOperationError);
  });
});
