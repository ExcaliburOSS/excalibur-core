import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, DEFAULT_CONFIG } from '@excalibur/shared';
import { makeTempDir, removeDir } from '../test-utils';
import { EXCALIBUR_DIR, loadExcaliburConfig } from './load-config';

describe('loadExcaliburConfig', () => {
  let repoRoot: string;
  let homeDir: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
    // A clean temp home keeps the user-global layer (P1.11b) hermetic — no real
    // ~/.config/excalibur/config.yaml can leak into these assertions.
    homeDir = makeTempDir();
  });

  afterEach(() => {
    removeDir(repoRoot);
    removeDir(homeDir);
  });

  /** Load with the global layer pointed at the (empty) temp home. */
  const load = (): ReturnType<typeof loadExcaliburConfig> =>
    loadExcaliburConfig(repoRoot, { homeDir });

  function writeConfig(yaml: string): void {
    mkdirSync(join(repoRoot, EXCALIBUR_DIR), { recursive: true });
    writeFileSync(join(repoRoot, EXCALIBUR_DIR, 'config.yaml'), yaml, 'utf8');
  }

  function writeGlobal(yaml: string): string {
    const dir = join(homeDir, '.config', 'excalibur');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'config.yaml');
    writeFileSync(p, yaml, 'utf8');
    return p;
  }

  it('returns the defaults when no config file exists', () => {
    const loaded = load();
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

    const loaded = load();
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
    const loaded = load();
    expect(loaded.config.commands?.test).toBe('npm test');
    expect(loaded.config.commands?.lint).toBe('npm run lint');
  });

  it('replaces list-valued sections instead of concatenating them', () => {
    writeConfig(['permissions:', '  blockedPaths:', '    - "custom/**"'].join('\n'));
    const loaded = load();
    expect(loaded.config.permissions?.blockedPaths).toEqual(['custom/**']);
    // sibling keys keep their defaults
    expect(loaded.config.permissions?.allowedCommands).toEqual(
      DEFAULT_CONFIG.permissions?.allowedCommands,
    );
  });

  it('treats an empty config file as all-defaults with source file', () => {
    writeConfig('');
    const loaded = load();
    expect(loaded.source).toBe('file');
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });

  it('throws ConfigValidationError on invalid YAML', () => {
    writeConfig('commands: [unbalanced');
    expect(() => load()).toThrowError(ConfigValidationError);
  });

  it('throws ConfigValidationError naming the offending path on schema violations', () => {
    writeConfig(['autonomy:', '  default: 9'].join('\n'));
    let caught: unknown;
    try {
      load();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect((caught as ConfigValidationError).code).toBe('config_validation');
    expect((caught as ConfigValidationError).message).toContain('autonomy.default');
  });

  describe('user-global layer (P1.11b)', () => {
    it('merges the global config UNDER the defaults when no project file exists', () => {
      const gp = writeGlobal(['ui:', '  theme: dark'].join('\n'));
      const loaded = load();
      expect(loaded.source).toBe('file');
      expect(loaded.globalPath).toBe(gp);
      expect(loaded.path).toBeUndefined(); // no project file
      expect(loaded.config.ui?.theme).toBe('dark'); // from global
      expect(loaded.config.safety?.preset).toBe('standard-safe'); // defaults survive
    });

    it('project config wins over the global layer (defaults < global < project)', () => {
      writeGlobal(['ui:', '  theme: dark', '  flavor: arthurian'].join('\n'));
      writeConfig(['ui:', '  theme: light'].join('\n'));
      const loaded = load();
      expect(loaded.config.ui?.theme).toBe('light'); // project overrides global
      expect(loaded.config.ui?.flavor).toBe('arthurian'); // global value not set by project survives
      expect(loaded.path).toBe(join(repoRoot, EXCALIBUR_DIR, 'config.yaml'));
      expect(loaded.globalPath).toBe(join(homeDir, '.config', 'excalibur', 'config.yaml'));
    });

    it('ignores the global layer when includeGlobal is false', () => {
      writeGlobal(['ui:', '  theme: dark'].join('\n'));
      const loaded = loadExcaliburConfig(repoRoot, { homeDir, includeGlobal: false });
      expect(loaded.source).toBe('defaults');
      expect(loaded.globalPath).toBeUndefined();
      expect(loaded.config.ui?.theme).toBeUndefined();
    });

    it('honors $XDG_CONFIG_HOME for the global path', () => {
      const xdg = makeTempDir();
      const prev = process.env['XDG_CONFIG_HOME'];
      process.env['XDG_CONFIG_HOME'] = xdg;
      try {
        const dir = join(xdg, 'excalibur');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'config.yaml'), ['ui:', '  theme: light'].join('\n'), 'utf8');
        const loaded = loadExcaliburConfig(repoRoot, { homeDir });
        expect(loaded.config.ui?.theme).toBe('light');
        expect(loaded.globalPath).toBe(join(dir, 'config.yaml'));
      } finally {
        if (prev === undefined) delete process.env['XDG_CONFIG_HOME'];
        else process.env['XDG_CONFIG_HOME'] = prev;
        removeDir(xdg);
      }
    });
  });
});
