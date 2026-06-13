import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_IN_EXTENSIONS } from '@excalibur/built-in-extensions';
import { DEFAULT_METHODOLOGIES, DEFAULT_WORKFLOWS } from '@excalibur/workflow-schema';
import { makeTempDir, removeDir } from '../test-utils';
import { createExtensionHost, workflowCatalog } from './host';

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
