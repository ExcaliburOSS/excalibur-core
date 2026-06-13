import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { Command } from 'commander';
import { buildProgram } from './program';
import { Ui } from './ui';

/** Test helpers shared by the CLI's colocated vitest suites. */

class MemoryStream extends Writable {
  chunks: string[] = [];

  override _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    // Strip ANSI escapes so assertions are color-independent.
    // eslint-disable-next-line no-control-regex
    return this.chunks.join('').replace(/\u001b\[[0-9;]*m/g, '');
  }
}

export interface TestCli {
  /** Parses argv (without node/script prefix) and resolves when done. */
  run(...argv: string[]): Promise<void>;
  stdout(): string;
  stderr(): string;
  /** Clears captured output between commands. */
  reset(): void;
  program: Command;
}

export interface TestCliOptions {
  cwd: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUserGlobal?: boolean;
}

export function createTestCli(options: TestCliOptions): TestCli {
  const out = new MemoryStream();
  const err = new MemoryStream();
  const ui = new Ui({ stdout: out, stderr: err, interactive: false });
  const homeDir = options.homeDir ?? makeTempDir('home');
  const program = buildProgram({
    ui,
    cwd: () => options.cwd,
    homeDir: () => homeDir,
    env: options.env ?? { PATH: process.env.PATH },
    includeUserGlobal: options.includeUserGlobal ?? false,
  });
  return {
    program,
    run: (...argv: string[]): Promise<void> =>
      program.parseAsync(['node', 'excalibur', ...argv]).then(() => undefined),
    stdout: (): string => out.text(),
    stderr: (): string => err.text(),
    reset: (): void => {
      out.chunks = [];
      err.chunks = [];
    },
  };
}

export function makeTempDir(prefix = 'cli'): string {
  return mkdtempSync(join(tmpdir(), `excalibur-cli-${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function git(repoRoot: string, args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=Excalibur Test', '-c', 'user.email=test@excalibur.local', ...args],
    { cwd: repoRoot, stdio: 'ignore' },
  );
}

export interface TempRepoOptions {
  git?: boolean;
  claudeMd?: boolean;
  skill?: boolean;
}

/** Creates a small plausible TypeScript repo in a temp directory. */
export function makeTempRepo(options: TempRepoOptions = {}): string {
  const dir = makeTempDir('repo');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'cli-test-repo',
        version: '1.0.0',
        scripts: { test: 'vitest run', lint: 'eslint .' },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# CLI test repo\n', 'utf8');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'service.ts'),
    'export function release(id: string): string {\n  return id;\n}\n',
    'utf8',
  );
  if (options.claudeMd !== false) {
    writeFileSync(join(dir, 'CLAUDE.md'), '# Project rules\n\nUse pnpm. Keep diffs small.\n', 'utf8');
  }
  if (options.skill === true) {
    const skillDir = join(dir, '.claude', 'skills', 'db-review');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: db-review',
        'description: Review database migrations for safety.',
        '---',
        '',
        '# DB review skill',
        '',
        '## When to use',
        '',
        '- Reviewing schema migrations',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  if (options.git !== false) {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'initial commit']);
  }
  return dir;
}
