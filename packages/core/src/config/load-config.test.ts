import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, DEFAULT_CONFIG } from '@excalibur/shared';
import { makeTempDir, removeDir } from '../test-utils';
import { EXCALIBUR_DIR, loadExcaliburConfig } from './load-config';

describe('loadExcaliburConfig', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(repoRoot, EXCALIBUR_DIR), { recursive: true });
    writeFileSync(join(repoRoot, EXCALIBUR_DIR, 'config.yaml'), yaml, 'utf8');
  }

  it('returns the defaults when no config file exists', () => {
    const loaded = loadExcaliburConfig(repoRoot);
    expect(loaded.source).toBe('defaults');
    expect(loaded.path).toBeUndefined();
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
    expect(loaded.config.safety?.preset).toBe('standard-safe');
  });

  it('merges a config file over the defaults (file values win)', () => {
    writeConfig(
      [
        'version: 1',
        'project:',
        '  name: my-app',
        '  packageManager: pnpm',
        'commands:',
        '  test: pnpm test',
        'workflows:',
        '  default: fast-fix',
      ].join('\n'),
    );

    const loaded = loadExcaliburConfig(repoRoot);
    expect(loaded.source).toBe('file');
    expect(loaded.path).toBe(join(repoRoot, EXCALIBUR_DIR, 'config.yaml'));
    expect(loaded.config.project?.name).toBe('my-app');
    expect(loaded.config.commands?.test).toBe('pnpm test');
    // File override wins inside merged sections…
    expect(loaded.config.workflows?.default).toBe('fast-fix');
    // …while untouched defaults survive the merge.
    expect(loaded.config.workflows?.byTaskType?.['bugfix']).toBe('fast-fix');
    expect(loaded.config.workflowDefaults?.['ask']).toBe('ask-repo');
    expect(loaded.config.permissions?.blockedPaths).toEqual(
      DEFAULT_CONFIG.permissions?.blockedPaths,
    );
  });

  it('normalizes the project.commands alias into the top-level commands', () => {
    writeConfig(
      ['project:', '  commands:', '    test: npm test', '    lint: npm run lint'].join('\n'),
    );
    const loaded = loadExcaliburConfig(repoRoot);
    expect(loaded.config.commands?.test).toBe('npm test');
    expect(loaded.config.commands?.lint).toBe('npm run lint');
  });

  it('replaces list-valued sections instead of concatenating them', () => {
    writeConfig(['permissions:', '  blockedPaths:', '    - "custom/**"'].join('\n'));
    const loaded = loadExcaliburConfig(repoRoot);
    expect(loaded.config.permissions?.blockedPaths).toEqual(['custom/**']);
    // sibling keys keep their defaults
    expect(loaded.config.permissions?.allowedCommands).toEqual(
      DEFAULT_CONFIG.permissions?.allowedCommands,
    );
  });

  it('treats an empty config file as all-defaults with source file', () => {
    writeConfig('');
    const loaded = loadExcaliburConfig(repoRoot);
    expect(loaded.source).toBe('file');
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });

  it('throws ConfigValidationError on invalid YAML', () => {
    writeConfig('commands: [unbalanced');
    expect(() => loadExcaliburConfig(repoRoot)).toThrowError(ConfigValidationError);
  });

  it('throws ConfigValidationError naming the offending path on schema violations', () => {
    writeConfig(['autonomy:', '  default: 9'].join('\n'));
    let caught: unknown;
    try {
      loadExcaliburConfig(repoRoot);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect((caught as ConfigValidationError).code).toBe('config_validation');
    expect((caught as ConfigValidationError).message).toContain('autonomy.default');
  });
});
