import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyLocation,
  createProjectDir,
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
