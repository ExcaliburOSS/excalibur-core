import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitOperationError } from '../errors';
import { git, initGitRepo, makeTempDir, removeDir } from '../test-utils';
import {
  addWorktree,
  applyPatch,
  checkPatchApplies,
  createBranch,
  getGitInfo,
  getLocalDiff,
  listRecentCommits,
  removeWorktree,
} from './git';

/** A valid new-file unified diff that creates `<relPath>` with `lines`. */
function newFileDiff(relPath: string, lines: string[]): string {
  return [
    '--- /dev/null',
    `+++ b/${relPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

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

  it('getLocalDiff includes brand-new untracked files as new-file hunks', () => {
    initGitRepo(repoRoot);
    writeFileSync(join(repoRoot, 'created.ts'), 'export const X = 1;\n', 'utf8');
    const diff = getLocalDiff(repoRoot);
    expect(diff).toContain('+++ b/created.ts');
    expect(diff).toContain('new file mode');
    expect(diff).toContain('+export const X = 1;');
    // The intent-to-add must be reverted: the file is untracked again.
    expect(git(repoRoot, ['status', '--porcelain']).trim()).toContain('?? created.ts');
  });

  it('getLocalDiff excludes Excalibur own state (.excalibur/) from the diff', () => {
    initGitRepo(repoRoot);
    writeFileSync(join(repoRoot, 'real-change.ts'), 'export const Z = 3;\n', 'utf8');
    // Simulate Excalibur writing its own run artifacts.
    const exDir = join(repoRoot, '.excalibur', 'runs', 'run_x');
    mkdirSync(exDir, { recursive: true });
    writeFileSync(join(exDir, 'run.json'), '{"id":"run_x"}\n', 'utf8');
    const diff = getLocalDiff(repoRoot);
    expect(diff).toContain('real-change.ts'); // user code surfaces
    expect(diff).not.toContain('.excalibur'); // tool state never pollutes the diff
  });

  it('getLocalDiff preserves changes the user had already staged', () => {
    initGitRepo(repoRoot);
    // README exists from initGitRepo; modify + stage it, then add an untracked file.
    writeFileSync(join(repoRoot, 'README.md'), '# Test repo\n\nStaged change.\n', 'utf8');
    git(repoRoot, ['add', 'README.md']);
    writeFileSync(join(repoRoot, 'extra.ts'), 'export const Y = 2;\n', 'utf8');
    const diff = getLocalDiff(repoRoot);
    expect(diff).toContain('+++ b/extra.ts'); // untracked surfaced
    expect(diff).toContain('Staged change.'); // staged change present
    // README must still be STAGED (index code 'M ') after the diff round-trip.
    const status = git(repoRoot, ['status', '--porcelain']);
    expect(status).toMatch(/^M {2}README\.md/m);
    expect(status).toContain('?? extra.ts');
  });

  it('removeWorktree force-removes a worktree with uncommitted changes (no leak)', () => {
    initGitRepo(repoRoot);
    const wt = join(repoRoot, '..', `wt_${Date.now()}`);
    addWorktree(repoRoot, wt, { branch: 'excalibur/wt-test' });
    // Dirty the worktree — a plain `git worktree remove` would refuse this.
    writeFileSync(join(wt, 'README.md'), 'uncommitted edit\n', 'utf8');
    const removed = removeWorktree(repoRoot, wt); // no force flag → relies on fallback
    expect(removed).toBe(true);
    expect(existsSync(wt)).toBe(false);
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

  describe('checkPatchApplies / applyPatch', () => {
    it('validates and applies a new-file diff, creating the file on disk', () => {
      initGitRepo(repoRoot);
      const diff = newFileDiff('src/new-file.ts', [
        "export const VALUE = 'created by excalibur';",
        'export function noop(): void {}',
      ]);

      expect(checkPatchApplies(repoRoot, diff)).toEqual({ applies: true, reason: null });

      expect(existsSync(join(repoRoot, 'src', 'new-file.ts'))).toBe(false);
      applyPatch(repoRoot, diff);
      expect(existsSync(join(repoRoot, 'src', 'new-file.ts'))).toBe(true);
      const written = readFileSync(join(repoRoot, 'src', 'new-file.ts'), 'utf8');
      expect(written).toContain("export const VALUE = 'created by excalibur';");
    });

    it('reports a malformed/non-applying diff without throwing, and applyPatch throws', () => {
      initGitRepo(repoRoot);
      // Modifies a file that does not exist → cannot apply.
      const nonApplying = [
        '--- a/does/not/exist.ts',
        '+++ b/does/not/exist.ts',
        '@@ -1,1 +1,1 @@',
        '-old line',
        '+new line',
      ].join('\n');

      const result = checkPatchApplies(repoRoot, nonApplying);
      expect(result.applies).toBe(false);
      expect(result.reason).not.toBeNull();
      expect((result.reason ?? '').length).toBeGreaterThan(0);

      expect(() => applyPatch(repoRoot, nonApplying)).toThrowError(GitOperationError);
    });

    it('treats an empty diff as not-applying / throwing', () => {
      initGitRepo(repoRoot);
      expect(checkPatchApplies(repoRoot, '   \n')).toEqual({ applies: false, reason: 'empty diff' });
      expect(() => applyPatch(repoRoot, '')).toThrowError(GitOperationError);
    });

    it('adds a trailing newline so a diff without one still applies', () => {
      initGitRepo(repoRoot);
      // No trailing newline on the diff string itself.
      const diff = newFileDiff('docs/note.md', ['hello', 'world']);
      expect(diff.endsWith('\n')).toBe(false);
      expect(checkPatchApplies(repoRoot, diff).applies).toBe(true);
      applyPatch(repoRoot, diff);
      expect(existsSync(join(repoRoot, 'docs', 'note.md'))).toBe(true);
    });
  });
});
