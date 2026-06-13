import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigValidationError } from '@excalibur/shared';
import { extensionsFileSchema, loadExtensionsFile } from './extensions-file';

/** extensions.yaml example from extensions spec §2 (verbatim). */
const SPEC_EXAMPLE = `
enabled:
  - discovery-pack
  - fast-fix
  - github-issues
  - openai-compatible
  - native-agent
local:
  - ./extensions/internal-tool
declarative:
  - ./methodologies/discovery.yaml
  - ./workflows/fast-fix.yaml
  - ./question-packs/agent-readiness.yaml
`;

describe('loadExtensionsFile', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'excalibur-extfile-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeExtensionsYaml(content: string): void {
    mkdirSync(join(repoRoot, '.excalibur'), { recursive: true });
    writeFileSync(join(repoRoot, '.excalibur', 'extensions.yaml'), content, 'utf8');
  }

  it('loads the spec example with enabled/local/declarative lists', () => {
    writeExtensionsYaml(SPEC_EXAMPLE);
    const config = loadExtensionsFile(repoRoot);
    expect(config.enabled).toEqual([
      'discovery-pack',
      'fast-fix',
      'github-issues',
      'openai-compatible',
      'native-agent',
    ]);
    expect(config.local).toEqual(['./extensions/internal-tool']);
    expect(config.declarative).toHaveLength(3);
    expect(config.disabled).toBeUndefined();
  });

  it('loads a disabled list', () => {
    writeExtensionsYaml('disabled:\n  - discovery-pack\n');
    expect(loadExtensionsFile(repoRoot).disabled).toEqual(['discovery-pack']);
  });

  it('returns an empty config when the file is missing', () => {
    expect(loadExtensionsFile(repoRoot)).toEqual({});
  });

  it('returns an empty config when the file is empty', () => {
    writeExtensionsYaml('');
    expect(loadExtensionsFile(repoRoot)).toEqual({});
  });

  it('throws ConfigValidationError on schema violations', () => {
    writeExtensionsYaml('enabled: not-a-list\n');
    expect(() => loadExtensionsFile(repoRoot)).toThrowError(ConfigValidationError);
    try {
      loadExtensionsFile(repoRoot);
    } catch (error) {
      expect((error as ConfigValidationError).code).toBe('config_validation');
      expect((error as ConfigValidationError).message).toContain('enabled');
    }
  });

  it('throws ConfigValidationError on invalid YAML', () => {
    writeExtensionsYaml('enabled: [unclosed');
    expect(() => loadExtensionsFile(repoRoot)).toThrowError(ConfigValidationError);
  });

  it('tolerates unknown keys (forward compatibility)', () => {
    writeExtensionsYaml('enabled: [a]\nfutureKey: whatever\n');
    expect(loadExtensionsFile(repoRoot).enabled).toEqual(['a']);
  });
});

describe('extensionsFileSchema', () => {
  it('accepts an empty object', () => {
    expect(extensionsFileSchema.parse({})).toEqual({});
  });

  it('rejects empty-string entries', () => {
    expect(extensionsFileSchema.safeParse({ disabled: [''] }).success).toBe(false);
  });
});
