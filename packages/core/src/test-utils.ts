import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { RepoAnalysis } from '@excalibur/context-engine';

/** Test helpers shared by the core package's colocated tests. */

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'excalibur-core-test-'));
}

/** Walks up from cwd to the pnpm monorepo root (pnpm-workspace.yaml). */
export function findMonorepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`pnpm-workspace.yaml not found above ${start}`);
    }
    dir = parent;
  }
}

export function demoRepoDir(): string {
  return join(findMonorepoRoot(), 'examples', 'demo-repo');
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function git(repoRoot: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Excalibur Test', '-c', 'user.email=test@excalibur.local', ...args],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Initializes a git repo with one commit in `dir`. */
export function initGitRepo(dir: string): void {
  git(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# Test repo\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial commit']);
}

/** Minimal RepoAnalysis stub for classifier and selection tests. */
export function fakeAnalysis(overrides: Partial<RepoAnalysis> = {}): RepoAnalysis {
  return {
    root: '/tmp/fake-repo',
    languages: ['typescript'],
    frameworks: ['nestjs'],
    packageManager: 'pnpm',
    commands: { test: 'pnpm test', lint: 'pnpm lint', typecheck: 'pnpm typecheck' },
    instructionFiles: [],
    patterns: {
      hasBackend: true,
      hasFrontend: false,
      testDirs: ['test'],
      migrationDirs: [],
      apiDirs: [],
      domainDirs: [],
      sensitivePaths: [],
    },
    suggestedWorkflows: [],
    instructionSources: [],
    skills: [],
    ...overrides,
  };
}
