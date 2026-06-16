import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_EXTENSIONS } from '@excalibur/built-in-extensions';
import type { ExtensionRegistry } from '@excalibur/extension-runtime';
import { DEFAULT_CONFIG, type ExcaliburConfig } from '@excalibur/shared';
import { DEFAULT_METHODOLOGIES, DEFAULT_WORKFLOWS } from '@excalibur/workflow-schema';
import { makeTempDir, removeDir } from '../test-utils';
import {
  collectExtensionMcpServers,
  createExtensionHost,
  withExtensionMcpServers,
  workflowCatalog,
} from './host';

describe('createExtensionHost', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('registers every built-in pack for a repo without .excalibur/', async () => {
    const registry = await createExtensionHost(repoRoot);

    const loadedIds = registry.extensions().map((extension) => extension.manifest.id);
    for (const pack of BUILT_IN_EXTENSIONS) {
      expect(loadedIds).toContain(pack.manifest.id);
    }

    const workflows = registry.contributions.workflows();
    expect(workflows).toHaveLength(DEFAULT_WORKFLOWS.length);
    expect(registry.contributions.methodologies()).toHaveLength(DEFAULT_METHODOLOGIES.length);

    const catalog = workflowCatalog(registry);
    expect(catalog.map((entry) => entry.id)).toContain('fast-fix');
    expect(catalog.map((entry) => entry.id)).toContain('ask-repo');
  });

  it('lets a project-level workflow file override the built-in with the same id', async () => {
    const workflowsDir = join(repoRoot, '.excalibur', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(workflowsDir, 'fast-fix.yaml'),
      [
        'id: fast-fix',
        'name: Project Fast Fix',
        'mode: fast',
        'supportedAutonomyLevels: [2, 3]',
        'phases:',
        '  - id: patch',
        '    name: Patch',
        '    type: patch_generation',
        '    output: diff.patch',
      ].join('\n'),
      'utf8',
    );

    const registry = await createExtensionHost(repoRoot);

    const contribution = registry.contributions.get('workflow', 'fast-fix');
    expect(contribution?.source).toBe('project');

    const catalog = workflowCatalog(registry);
    expect(catalog).toHaveLength(DEFAULT_WORKFLOWS.length); // override, not addition
    const fastFix = catalog.find((entry) => entry.id === 'fast-fix');
    expect(fastFix?.definition.name).toBe('Project Fast Fix');
    expect(fastFix?.definition.phases).toHaveLength(1);
  });
});

type McpSpec = { name: string; command: string; args?: string[]; cwd?: string; env?: Record<string, string> };
type FakeExt = { status: 'loaded' | 'error'; id: string; mcpServers?: McpSpec[] };

/** A structural fake registry — the EXT-6 helpers only call `extensions()`. */
function fakeRegistry(exts: FakeExt[]): ExtensionRegistry {
  return {
    extensions: () =>
      exts.map((e) => ({
        manifest: { id: e.id, contributes: e.mcpServers !== undefined ? { mcpServers: e.mcpServers } : {} },
        dir: null,
        status: e.status,
      })),
  } as unknown as ExtensionRegistry;
}

const cfgWith = (servers?: Record<string, { command: string }>): ExcaliburConfig =>
  ({ ...DEFAULT_CONFIG, ...(servers !== undefined ? { mcp: { servers } } : {}) }) as ExcaliburConfig;

describe('collectExtensionMcpServers (EXT-6)', () => {
  it('collects MCP servers from loaded extensions, keyed by name', () => {
    const servers = collectExtensionMcpServers(
      fakeRegistry([
        { status: 'loaded', id: 'a', mcpServers: [{ name: 'gh', command: 'gh-mcp', args: ['--stdio'] }] },
        { status: 'loaded', id: 'b', mcpServers: [{ name: 'fs', command: 'fs-mcp', env: { ROOT: '/tmp' } }] },
      ]),
    );
    expect(Object.keys(servers).sort()).toEqual(['fs', 'gh']);
    expect(servers['gh']).toEqual({ command: 'gh-mcp', args: ['--stdio'] });
    expect(servers['fs']).toEqual({ command: 'fs-mcp', env: { ROOT: '/tmp' } });
  });

  it('ignores failed extensions', () => {
    expect(
      collectExtensionMcpServers(
        fakeRegistry([{ status: 'error', id: 'broken', mcpServers: [{ name: 'x', command: 'x' }] }]),
      ),
    ).toEqual({});
  });

  it('later extensions override earlier ones on a name clash (load order)', () => {
    const servers = collectExtensionMcpServers(
      fakeRegistry([
        { status: 'loaded', id: 'a', mcpServers: [{ name: 'gh', command: 'old' }] },
        { status: 'loaded', id: 'b', mcpServers: [{ name: 'gh', command: 'new' }] },
      ]),
    );
    expect(servers['gh']).toEqual({ command: 'new' });
  });
});

describe('withExtensionMcpServers (EXT-6)', () => {
  it('merges contributed servers into mcp.servers', () => {
    const merged = withExtensionMcpServers(
      cfgWith(),
      fakeRegistry([{ status: 'loaded', id: 'a', mcpServers: [{ name: 'gh', command: 'gh-mcp' }] }]),
    );
    expect(merged.mcp?.servers?.['gh']).toEqual({ command: 'gh-mcp' });
  });

  it("the repo's OWN config.mcp.servers wins on a name clash", () => {
    const merged = withExtensionMcpServers(
      cfgWith({ gh: { command: 'repo-configured' } }),
      fakeRegistry([{ status: 'loaded', id: 'a', mcpServers: [{ name: 'gh', command: 'from-extension' }] }]),
    );
    expect(merged.mcp?.servers?.['gh']).toEqual({ command: 'repo-configured' });
  });

  it('returns config UNCHANGED when no extension contributes a server (MCP stays as configured)', () => {
    const config = cfgWith();
    const merged = withExtensionMcpServers(config, fakeRegistry([{ status: 'loaded', id: 'a' }]));
    expect(merged).toBe(config); // same reference — nothing added, MCP untouched (incl. off)
  });
});
