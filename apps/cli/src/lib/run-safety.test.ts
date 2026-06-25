import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureRestorePoint, isDirty } from './run-safety';

let repo: string;
const git = (args: string[]): void => {
  execFileSync('git', args, { cwd: repo });
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-safety-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('run-safety', () => {
  it('reports a clean tree and captures HEAD with no snapshot', () => {
    expect(isDirty(repo)).toBe(false);
    const point = captureRestorePoint(repo);
    expect(point.head).toMatch(/^[0-9a-f]{40}$/);
    expect(point.wasDirty).toBe(false);
    expect(point.snapshot).toBeNull();
  });

  it('detects a dirty tree and snapshots the uncommitted changes (without touching them)', () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); // uncommitted change
    expect(isDirty(repo)).toBe(true);
    const point = captureRestorePoint(repo);
    expect(point.wasDirty).toBe(true);
    expect(point.snapshot).toMatch(/^[0-9a-f]{40}$/); // a dangling snapshot commit
    // The snapshot must NOT have modified the working tree.
    expect(isDirty(repo)).toBe(true);
  });

  it('degrades to a no-op outside a git repository', () => {
    const notGit = mkdtempSync(join(tmpdir(), 'exc-nogit-'));
    try {
      expect(isDirty(notGit)).toBe(false);
      const point = captureRestorePoint(notGit);
      expect(point.head).toBeNull();
      expect(point.snapshot).toBeNull();
    } finally {
      rmSync(notGit, { recursive: true, force: true });
    }
  });
});
