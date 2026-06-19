import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigValidationError } from '@excalibur/shared';
import { extensionManifestSchema, loadManifest, validateManifest } from './manifest';

/** Declarative pack example from extensions spec §3 (verbatim). */
const DECLARATIVE_PACK_YAML = `
id: discovery-pack
name: Discovery Pack
version: 0.1.0
kind: declarative
description: Lightweight pre-work methodology for clarifying ideas, tickets and feedback before implementation.
contributes:
  methodologies:
    - ./methodologies/discovery.yaml
  workflows:
    - ./workflows/discovery.yaml
  questionPacks:
    - ./question-packs/product-discovery.yaml
    - ./question-packs/agent-readiness.yaml
  artifactTemplates:
    - ./artifacts/refined-ticket.md
    - ./artifacts/mvp-scope.md
    - ./artifacts/readiness-assessment.md
  promptTemplates:
    - ./prompts/discovery-synthesis.md
  roleDefinitions:
    - ./roles/product-strategist.yaml
    - ./roles/scope-guardian.yaml
`;

/** Programmatic example from extensions spec §3 (verbatim). */
const PROGRAMMATIC_YAML = `
id: linear
name: Linear
version: 0.1.0
kind: programmatic
description: Linear work item provider for Excalibur.
entrypoint: dist/index.js
contributes:
  workItemProviders:
    - linear
capabilities:
  - work_items.read
  - work_items.comment
  - work_items.update_status
  - work_items.link_pr
configSchema:
  apiKeyEnv:
    type: string
    required: true
  workspace:
    type: string
    required: false
permissions:
  network:
    allowedHosts:
      - api.linear.app
`;

describe('extensionManifestSchema / validateManifest', () => {
  it('accepts the declarative pack example from the spec', () => {
    const result = validateManifest(parseYaml(DECLARATIVE_PACK_YAML));
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
    expect(result.data?.id).toBe('discovery-pack');
    expect(result.data?.kind).toBe('declarative');
    expect(result.data?.contributes?.questionPacks).toEqual([
      './question-packs/product-discovery.yaml',
      './question-packs/agent-readiness.yaml',
    ]);
    expect(result.data?.contributes?.artifactTemplates).toHaveLength(3);
  });

  it('accepts the programmatic example from the spec', () => {
    const result = validateManifest(parseYaml(PROGRAMMATIC_YAML));
    expect(result.success).toBe(true);
    const manifest = result.data;
    expect(manifest?.kind).toBe('programmatic');
    expect(manifest?.entrypoint).toBe('dist/index.js');
    expect(manifest?.contributes?.workItemProviders).toEqual(['linear']);
    expect(manifest?.capabilities).toContain('work_items.read');
    expect(manifest?.configSchema?.apiKeyEnv).toEqual({ type: 'string', required: true });
    expect(manifest?.permissions?.network?.allowedHosts).toEqual(['api.linear.app']);
  });

  it('accepts a declarative extension that contributes MCP servers (EXT-6)', () => {
    const result = validateManifest(
      parseYaml(`
id: github-mcp
name: GitHub MCP
version: 0.1.0
kind: declarative
contributes:
  mcpServers:
    - name: github
      command: gh-mcp-server
      args: ['--stdio']
      env:
        GH_HOST: github.com
permissions:
  process:
    allowedCommands:
      - gh-mcp-server
  secrets:
    env:
      - GITHUB_TOKEN
`),
    );
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
    expect(result.data?.contributes?.mcpServers).toEqual([
      {
        name: 'github',
        command: 'gh-mcp-server',
        args: ['--stdio'],
        env: { GH_HOST: 'github.com' },
      },
    ]);
    // The spawned MCP process is governed by the manifest's own process/secrets perms.
    expect(result.data?.permissions?.process?.allowedCommands).toEqual(['gh-mcp-server']);
  });

  it('accepts a mixed extension with both contributions and an entrypoint', () => {
    const result = validateManifest({
      id: 'mixed-ext',
      name: 'Mixed',
      version: '1.0.0',
      kind: 'mixed',
      entrypoint: 'dist/index.js',
      contributes: { workflows: ['./workflows/x.yaml'], tools: ['my-tool'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a programmatic manifest without an entrypoint', () => {
    const result = validateManifest({
      id: 'linear',
      name: 'Linear',
      version: '0.1.0',
      kind: 'programmatic',
    });
    expect(result.success).toBe(false);
    expect(result.errors?.join('\n')).toContain('entrypoint');
  });

  it('rejects a mixed manifest without an entrypoint', () => {
    const result = validateManifest({
      id: 'mixed-ext',
      name: 'Mixed',
      version: '0.1.0',
      kind: 'mixed',
    });
    expect(result.success).toBe(false);
    expect(result.errors?.join('\n')).toContain('entrypoint');
  });

  it('rejects a declarative manifest that declares an entrypoint', () => {
    const result = validateManifest({
      id: 'pack',
      name: 'Pack',
      version: '0.1.0',
      kind: 'declarative',
      entrypoint: 'dist/index.js',
    });
    expect(result.success).toBe(false);
    expect(result.errors?.join('\n')).toContain('entrypoint');
  });

  it('rejects manifests missing required fields, with readable paths', () => {
    const result = validateManifest({ name: 'No id', kind: 'declarative' });
    expect(result.success).toBe(false);
    const text = result.errors?.join('\n') ?? '';
    expect(text).toContain('id');
    expect(text).toContain('version');
  });

  it('rejects an unknown kind', () => {
    const result = validateManifest({
      id: 'x',
      name: 'X',
      version: '1.0.0',
      kind: 'plugin',
    });
    expect(result.success).toBe(false);
    expect(result.errors?.join('\n')).toContain('kind');
  });

  it('rejects ids that are not slugs', () => {
    const result = validateManifest({
      id: 'my extension!',
      name: 'X',
      version: '1.0.0',
      kind: 'declarative',
    });
    expect(result.success).toBe(false);
    expect(result.errors?.join('\n')).toContain('id');
  });

  it('rejects malformed contributes and configSchema entries', () => {
    const badContributes = validateManifest({
      id: 'x',
      name: 'X',
      version: '1.0.0',
      kind: 'declarative',
      contributes: { workflows: 'not-a-list' },
    });
    expect(badContributes.success).toBe(false);

    const badConfig = validateManifest({
      id: 'x',
      name: 'X',
      version: '1.0.0',
      kind: 'programmatic',
      entrypoint: 'dist/index.js',
      configSchema: { apiKeyEnv: { required: true } },
    });
    expect(badConfig.success).toBe(false);
    expect(badConfig.errors?.join('\n')).toContain('configSchema');
  });

  it('keeps unknown permission categories (passthrough) for later warning', () => {
    const parsed = extensionManifestSchema.parse({
      id: 'x',
      name: 'X',
      version: '1.0.0',
      kind: 'programmatic',
      entrypoint: 'dist/index.js',
      permissions: { telepathy: { read: true } },
    });
    expect(parsed.permissions).toHaveProperty('telepathy');
  });
});

describe('loadManifest', () => {
  let dir: string;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads and validates a manifest file from disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'excalibur-manifest-'));
    const filePath = join(dir, 'excalibur.extension.yaml');
    writeFileSync(filePath, PROGRAMMATIC_YAML, 'utf8');
    const manifest = loadManifest(filePath);
    expect(manifest.id).toBe('linear');
    expect(manifest.entrypoint).toBe('dist/index.js');
  });

  it('throws ConfigValidationError when the file is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'excalibur-manifest-'));
    const filePath = join(dir, 'excalibur.extension.yaml');
    expect(() => loadManifest(filePath)).toThrowError(ConfigValidationError);
    try {
      loadManifest(filePath);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).code).toBe('config_validation');
    }
  });

  it('throws ConfigValidationError on invalid YAML', () => {
    dir = mkdtempSync(join(tmpdir(), 'excalibur-manifest-'));
    const filePath = join(dir, 'excalibur.extension.yaml');
    writeFileSync(filePath, 'id: [unclosed', 'utf8');
    expect(() => loadManifest(filePath)).toThrowError(ConfigValidationError);
  });

  it('throws ConfigValidationError with readable messages on schema violations', () => {
    dir = mkdtempSync(join(tmpdir(), 'excalibur-manifest-'));
    const filePath = join(dir, 'excalibur.extension.yaml');
    writeFileSync(
      filePath,
      ['id: broken', 'name: Broken', 'version: 0.1.0', 'kind: programmatic'].join('\n'),
      'utf8',
    );
    expect(() => loadManifest(filePath)).toThrowError(/entrypoint/);
  });
});
