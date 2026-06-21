import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadSecretsIntoEnv,
  parseEnvFile,
  saveSecret,
  secretsFilePath,
  SECRETS_RELATIVE_PATH,
} from './secrets-store';

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'excalibur-secrets-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('parses KEY=value, skips blanks/comments/garbage, strips quotes', () => {
    const text = [
      '# a comment',
      '',
      'MOONSHOT_API_KEY=sk-abc123',
      'QUOTED="with spaces"',
      "SINGLE='single'",
      'not a valid line',
      'lowercase=ignored',
      'EMPTY=',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual([
      ['MOONSHOT_API_KEY', 'sk-abc123'],
      ['QUOTED', 'with spaces'],
      ['SINGLE', 'single'],
      ['EMPTY', ''],
    ]);
  });
});

describe('saveSecret + loadSecretsIntoEnv', () => {
  it('round-trips a pasted key and writes the file 0600', () => {
    const filePath = saveSecret('KIMI_CODE_API_KEY', 'sk-live-xyz', baseDir);
    expect(filePath).toBe(join(baseDir, SECRETS_RELATIVE_PATH));
    expect(readFileSync(filePath, 'utf8')).toContain('KIMI_CODE_API_KEY=sk-live-xyz');
    // Owner-only permission (skipped on platforms without POSIX modes).
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }

    const env: NodeJS.ProcessEnv = {};
    expect(loadSecretsIntoEnv(env, baseDir)).toBe(1);
    expect(env['KIMI_CODE_API_KEY']).toBe('sk-live-xyz');
  });

  it('upserts in place, preserving other entries and order', () => {
    saveSecret('A_KEY', 'one', baseDir);
    saveSecret('B_KEY', 'two', baseDir);
    saveSecret('A_KEY', 'updated', baseDir);
    const env: NodeJS.ProcessEnv = {};
    loadSecretsIntoEnv(env, baseDir);
    expect(env['A_KEY']).toBe('updated');
    expect(env['B_KEY']).toBe('two');
  });

  it('the real environment wins — load only fills gaps', () => {
    saveSecret('GROQ_API_KEY', 'from-file', baseDir);
    const env: NodeJS.ProcessEnv = { GROQ_API_KEY: 'from-shell' };
    expect(loadSecretsIntoEnv(env, baseDir)).toBe(0);
    expect(env['GROQ_API_KEY']).toBe('from-shell');
  });

  it('missing file is a no-op (returns 0)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadSecretsIntoEnv(env, baseDir)).toBe(0);
    expect(secretsFilePath(baseDir)).toBe(join(baseDir, SECRETS_RELATIVE_PATH));
  });

  it('rejects an invalid name or empty value', () => {
    expect(() => saveSecret('bad-name', 'x', baseDir)).toThrow();
    expect(() => saveSecret('OK_NAME', '', baseDir)).toThrow();
  });
});
