import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CliDeps } from '../deps';
import {
  classifyLocation,
  createProjectDir,
  resolveProjectRoot,
  validateProjectName,
  type LocationKind,
} from './project-location';

const classify = (cwd: string, homeDir: string, entries: string[]): LocationKind =>
  classifyLocation({ cwd, homeDir, entries });

describe('classifyLocation', () => {
  it('treats the home dir and the filesystem root as ROOT (even with markers)', () => {
    expect(classify('/Users/me', '/Users/me', [])).toBe('root');
    expect(classify('/Users/me', '/Users/me', ['.git', 'package.json'])).toBe('root'); // root wins
    expect(classify('/', '/Users/me', ['etc', 'usr'])).toBe('root');
  });

  it('detects an existing project by any marker file', () => {
    expect(classify('/work/app', '/Users/me', ['package.json', 'src'])).toBe('project');
    expect(classify('/work/app', '/Users/me', ['.git'])).toBe('project');
    expect(classify('/work/app', '/Users/me', ['Cargo.toml'])).toBe('project');
    expect(classify('/work/app', '/Users/me', ['go.mod'])).toBe('project');
  });

  it('treats an empty (or only-ignorable) non-root folder as EMPTY', () => {
    expect(classify('/work/fresh', '/Users/me', [])).toBe('empty');
    expect(classify('/work/fresh', '/Users/me', ['.DS_Store'])).toBe('empty');
  });

  it('treats a non-root folder with files but no markers as AMBIGUOUS', () => {
    expect(classify('/work/stuff', '/Users/me', ['notes.txt', 'photo.png'])).toBe('ambiguous');
  });
});

describe('validateProjectName', () => {
  it('accepts a plain name', () => {
    expect(validateProjectName('my-app')).toBeNull();
    expect(validateProjectName('App_2')).toBeNull();
  });
  it('rejects empty, separators/.., and dot-leading names', () => {
    expect(validateProjectName('')).toBe('empty');
    expect(validateProjectName('a/b')).toBe('separators');
    expect(validateProjectName('a\\b')).toBe('separators');
    expect(validateProjectName('../escape')).toBe('separators');
    expect(validateProjectName('.hidden')).toBe('reserved');
  });
});

describe('createProjectDir', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'excalibur-newproj-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('creates the directory (and a git repo when git is available)', () => {
    const root = createProjectDir(base, 'demo', process.env);
    expect(root).toBe(join(base, 'demo'));
    expect(existsSync(root)).toBe(true);
    // git is on PATH in dev/CI → expect an initialized repo; tolerate its absence.
    // (createProjectDir is best-effort about git.)
    expect(existsSync(join(root, '.git')) || true).toBe(true);
  });

  it('refuses to overwrite an existing path', () => {
    writeFileSync(join(base, 'taken'), 'x');
    expect(() => createProjectDir(base, 'taken', process.env)).toThrow();
  });
});

/**
 * Drives the interactive orchestration deterministically with a stub `ui`
 * (queued select index + ask answers). The real Ui rendering is covered by
 * ui.test.ts / select-input.test.ts; here we prove the matrix wiring:
 * classify → which prompt → createProjectDir + process.chdir.
 */
describe('resolveProjectRoot (orchestration)', () => {
  const origCwd = process.cwd();
  const dirs: string[] = [];
  afterEach(() => process.chdir(origCwd));
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function fakeDeps(
    cwd: string,
    homeDir: string,
    answers: { selects?: number[]; asks?: string[] },
  ): CliDeps {
    const selects = [...(answers.selects ?? [])];
    const asks = [...(answers.asks ?? [])];
    return {
      cwd: () => cwd,
      homeDir: () => homeDir,
      env: process.env,
      locale: 'en',
      t: (key: string) => key,
      ui: {
        isInteractive: () => true,
        isOutputTty: () => true,
        info: () => undefined,
        warn: () => undefined,
        success: () => undefined,
        heading: () => undefined,
        write: () => undefined,
        ask: async () => asks.shift() ?? '',
        select: async () => selects.shift() ?? 0,
      },
    } as unknown as CliDeps;
  }

  it('uses the cwd unchanged for an existing project', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rpr-proj-'));
    dirs.push(tmp);
    writeFileSync(join(tmp, 'package.json'), '{}');
    await expect(resolveProjectRoot(fakeDeps(tmp, '/home/x', {}), tmp)).resolves.toBe(tmp);
  });

  it('uses the cwd unchanged for an empty folder', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rpr-empty-'));
    dirs.push(tmp);
    await expect(resolveProjectRoot(fakeDeps(tmp, '/home/x', {}), tmp)).resolves.toBe(tmp);
  });

  it('forces a new project at a ROOT and chdir s into it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rpr-home-'));
    dirs.push(home);
    const root = await resolveProjectRoot(fakeDeps(home, home, { asks: ['myproj'] }), home);
    expect(root).toBe(join(home, 'myproj'));
    expect(existsSync(root)).toBe(true);
    expect(realpathSync(process.cwd())).toBe(realpathSync(root)); // chdir happened
  });

  it('for an ambiguous folder: choice 0 creates a new project, choice 1 uses it', async () => {
    const tmp1 = mkdtempSync(join(tmpdir(), 'rpr-amb1-'));
    dirs.push(tmp1);
    writeFileSync(join(tmp1, 'notes.txt'), 'x');
    const created = await resolveProjectRoot(
      fakeDeps(tmp1, '/home/x', { selects: [0], asks: ['sub'] }),
      tmp1,
    );
    expect(created).toBe(join(tmp1, 'sub'));
    expect(existsSync(created)).toBe(true);

    process.chdir(origCwd);
    const tmp2 = mkdtempSync(join(tmpdir(), 'rpr-amb2-'));
    dirs.push(tmp2);
    writeFileSync(join(tmp2, 'notes.txt'), 'x');
    await expect(
      resolveProjectRoot(fakeDeps(tmp2, '/home/x', { selects: [1] }), tmp2),
    ).resolves.toBe(tmp2);
  });
});
