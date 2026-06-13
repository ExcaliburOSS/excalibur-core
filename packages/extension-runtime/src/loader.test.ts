import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Contribution } from './contributions';
import { loadExtensions, PROJECT_EXTENSION_ID } from './loader';
import type { BuiltInExtensionPack } from './registry';

function write(repoRoot: string, relPath: string, content: string): void {
  const absPath = join(repoRoot, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf8');
}

function workflowYaml(id: string, name: string): string {
  return [
    `id: ${id}`,
    `name: ${name}`,
    'mode: fast',
    'phases:',
    '  - id: work',
    '    name: Agent work',
    '    type: agent_work',
    '',
  ].join('\n');
}

function workflowContribution(extensionId: string, id: string, name: string): Contribution {
  return {
    kind: 'workflow',
    id,
    extensionId,
    source: 'built_in',
    definition: {
      id,
      name,
      mode: 'fast',
      phases: [{ id: 'work', name: 'Agent work', type: 'agent_work' }],
    },
  };
}

const CORE_WORKFLOWS_PACK: BuiltInExtensionPack = {
  manifest: {
    id: 'core-workflows',
    name: 'Core workflows',
    version: '0.1.0',
    kind: 'declarative',
  },
  contributions: [workflowContribution('core-workflows', 'fast-fix', 'Fast fix (built-in)')],
};

const CORE_METHODOLOGIES_PACK: BuiltInExtensionPack = {
  manifest: {
    id: 'core-methodologies',
    name: 'Core methodologies',
    version: '0.1.0',
    kind: 'declarative',
  },
  contributions: [
    {
      kind: 'methodology',
      id: 'lightweight',
      extensionId: 'core-methodologies',
      source: 'built_in',
      definition: {
        id: 'lightweight',
        name: 'Lightweight',
        description: 'Minimal ceremony delivery.',
      },
    },
  ],
};

const BUILT_INS: ReadonlyArray<BuiltInExtensionPack> = [
  CORE_WORKFLOWS_PACK,
  CORE_METHODOLOGIES_PACK,
];

describe('loadExtensions', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'excalibur-loader-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('loads built-ins in a repo with no .excalibur directory at all', async () => {
    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });

    const extensions = registry.extensions();
    expect(extensions.map((e) => e.manifest.id)).toEqual(['core-workflows', 'core-methodologies']);
    expect(extensions.every((e) => e.source === 'built_in' && e.status === 'loaded')).toBe(true);
    expect(extensions.every((e) => e.dir === null)).toBe(true);
    expect(registry.contributions.workflows().map((w) => w.name)).toEqual([
      'Fast fix (built-in)',
    ]);
    expect(registry.contributions.methodologies()).toHaveLength(1);
    expect(registry.contributions.warnings()).toEqual([]);
    expect(registry.hooks.handlerCount('run.created')).toBe(0);
  });

  it('scans the 10 project declarative directories and registers project contributions', async () => {
    write(repoRoot, '.excalibur/workflows/safe-hotfix.yaml', workflowYaml('safe-hotfix', 'Safe hotfix'));
    write(
      repoRoot,
      '.excalibur/methodologies/spike.yaml',
      ['id: spike', 'name: Spike', 'description: Timeboxed exploration.', ''].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/question-packs/readiness.yaml',
      [
        'id: readiness',
        'name: Readiness',
        'questions:',
        '  - id: q1',
        '    text: Is the scope clear?',
        '',
      ].join('\n'),
    );
    write(repoRoot, '.excalibur/prompts/pr-summary.md', '# PR summary\n\nSummarize {{diff}}.\n');
    write(repoRoot, '.excalibur/artifacts/refined-ticket.md', '# {{title}}\n\n{{body}}\n');
    write(
      repoRoot,
      '.excalibur/policies/strict.yaml',
      [
        'id: strict',
        'rules:',
        '  - id: deny-env',
        '    when:',
        '      filePathMatches:',
        "        - '.env*'",
        '    decision: deny',
        '',
      ].join('\n'),
    );
    write(repoRoot, '.excalibur/models/routing.yaml', 'id: default-routing\ndefault: mock\n');
    write(repoRoot, '.excalibur/models/providers.yaml', 'providers:\n  default: mock\n');
    write(
      repoRoot,
      '.excalibur/reports/daily.yaml',
      ['id: daily', 'name: Daily report', 'sections:', '  - runs', '  - patches', ''].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/roles/scope-guardian.yaml',
      ['id: scope-guardian', 'name: Scope guardian', 'description: Keeps scope honest.', ''].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/command-mappings/wi.yaml',
      ['id: wi', 'commands:', '  - trigger: run', '    action: start_run', ''].join('\n'),
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    const c = registry.contributions;

    expect(c.get('workflow', 'safe-hotfix')?.source).toBe('project');
    expect(c.get('methodology', 'spike')?.source).toBe('project');
    expect(c.get('question_pack', 'readiness')).toBeDefined();
    expect(c.get('prompt_template', 'pr-summary')).toBeDefined();
    expect(c.get('artifact_template', 'refined-ticket')).toBeDefined();
    expect(c.get('policy_preset', 'strict')).toBeDefined();
    expect(c.get('model_routing', 'default-routing')).toBeDefined();
    expect(c.get('report_template', 'daily')).toBeDefined();
    expect(c.get('role_definition', 'scope-guardian')).toBeDefined();
    expect(c.get('command_mapping', 'wi')).toBeDefined();

    // providers.yaml is model provider config, not a declarative definition.
    expect(c.list('model_routing')).toHaveLength(1);
    expect(c.warnings()).toEqual([]);

    const project = registry.getExtension(PROJECT_EXTENSION_ID);
    expect(project?.source).toBe('project');
    expect(project?.status).toBe('loaded');
    expect(project?.dir).toBe(join(repoRoot, '.excalibur'));

    // Markdown artifact templates auto-extract their variables.
    const artifact = c.get('artifact_template', 'refined-ticket')?.definition;
    expect((artifact as { variables: string[] }).variables).toEqual(['title', 'body']);
  });

  it('lets a project workflow override the built-in one with the same id', async () => {
    write(repoRoot, '.excalibur/workflows/fast-fix.yaml', workflowYaml('fast-fix', 'Fast fix (project)'));

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    const workflows = registry.contributions.workflows();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.name).toBe('Fast fix (project)');
    expect(registry.contributions.get('workflow', 'fast-fix')?.source).toBe('project');
    expect(registry.contributions.warnings()).toEqual([]);
  });

  it('loads files from the extensions.yaml declarative list without double-loading scanned files', async () => {
    write(repoRoot, '.excalibur/workflows/safe-hotfix.yaml', workflowYaml('safe-hotfix', 'Safe hotfix'));
    write(
      repoRoot,
      '.excalibur/custom/special.yaml',
      [
        'id: special',
        'type: question_pack',
        'name: Special pack',
        'questions:',
        '  - id: q1',
        '    text: Why?',
        '',
      ].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/extensions.yaml',
      [
        'declarative:',
        '  - ./workflows/safe-hotfix.yaml',
        '  - ./custom/special.yaml',
        '  - ./missing.yaml',
        '',
      ].join('\n'),
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    expect(registry.contributions.get('workflow', 'safe-hotfix')).toBeDefined();
    expect(registry.contributions.get('question_pack', 'special')).toBeDefined();

    // The overlap between scan and declarative list must not produce a duplicate warning.
    const warnings = registry.contributions.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('./missing.yaml');
  });

  it('records a warning for a broken project declarative file instead of throwing', async () => {
    write(repoRoot, '.excalibur/workflows/good.yaml', workflowYaml('good', 'Good'));
    write(repoRoot, '.excalibur/workflows/broken.yaml', 'id: broken\nname: Broken\n');

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    expect(registry.contributions.get('workflow', 'good')).toBeDefined();
    expect(registry.contributions.get('workflow', 'broken')).toBeUndefined();
    const warnings = registry.contributions.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('broken.yaml');
  });

  it('loads a local programmatic extension with a compiled entrypoint', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/internal-tool/excalibur.extension.yaml',
      [
        'id: internal-tool',
        'name: Internal Tool',
        'version: 0.1.0',
        'kind: programmatic',
        'entrypoint: dist/index.js',
        'contributes:',
        '  workItemProviders:',
        '    - internal',
        'permissions:',
        '  network:',
        '    allowedHosts:',
        '      - internal.example.com',
        '',
      ].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/extensions/internal-tool/dist/index.js',
      `module.exports = { default: { id: 'internal-tool', name: 'Internal Tool', version: '0.1.0', register() {} } };\n`,
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    const extension = registry.getExtension('internal-tool');
    expect(extension?.status).toBe('loaded');
    expect(extension?.source).toBe('local');
    expect(extension?.dir).toBe(join(repoRoot, '.excalibur', 'extensions', 'internal-tool'));
    expect(extension?.error).toBeUndefined();
    expect(extension?.instance).toBeDefined();

    const contribution = registry.contributions.get('work_item_provider', 'internal');
    expect(contribution?.source).toBe('local');
    expect(contribution?.extensionId).toBe('internal-tool');
    expect(contribution?.value).toBe(extension?.instance);
  });

  it('does not load the same local extension twice when listed in local: and present in .excalibur/extensions/', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/internal-tool/excalibur.extension.yaml',
      [
        'id: internal-tool',
        'name: Internal Tool',
        'version: 0.1.0',
        'kind: programmatic',
        'entrypoint: dist/index.js',
        '',
      ].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/extensions/internal-tool/dist/index.js',
      `module.exports = { id: 'internal-tool', register() {} };\n`,
    );
    write(repoRoot, '.excalibur/extensions.yaml', 'local:\n  - ./extensions/internal-tool\n');

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    const matches = registry.extensions().filter((e) => e.manifest.id === 'internal-tool');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.status).toBe('loaded');
  });

  it('loads an installed declarative pack with project source (no code → project-level content)', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/team-pack/excalibur.extension.yaml',
      [
        'id: team-pack',
        'name: Team Pack',
        'version: 1.0.0',
        'kind: declarative',
        'contributes:',
        '  workflows:',
        '    - ./workflows/team-flow.yaml',
        '  questionPacks:',
        '    - ./question-packs/team-questions.yaml',
        '',
      ].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/extensions/team-pack/workflows/team-flow.yaml',
      workflowYaml('team-flow', 'Team flow'),
    );
    write(
      repoRoot,
      '.excalibur/extensions/team-pack/question-packs/team-questions.yaml',
      ['id: team-questions', 'name: Team questions', 'questions:', '  - id: q1', '    text: Who owns this?', ''].join('\n'),
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    expect(registry.getExtension('team-pack')?.status).toBe('loaded');
    expect(registry.getExtension('team-pack')?.source).toBe('project');
    expect(registry.contributions.get('workflow', 'team-flow')?.source).toBe('project');
    expect(registry.contributions.get('question_pack', 'team-questions')?.extensionId).toBe('team-pack');
  });

  it('records a missing entrypoint as a per-extension error without crashing the load', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/broken-tool/excalibur.extension.yaml',
      [
        'id: broken-tool',
        'name: Broken Tool',
        'version: 0.1.0',
        'kind: programmatic',
        'entrypoint: dist/index.js',
        '',
      ].join('\n'),
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    const extension = registry.getExtension('broken-tool');
    expect(extension?.status).toBe('error');
    expect(extension?.error).toContain('entrypoint not found');
    // The rest of the world keeps working.
    expect(registry.contributions.workflows()).toHaveLength(1);
    expect(registry.getExtension('core-workflows')?.status).toBe('loaded');
  });

  it('records an entrypoint that throws at require time as a per-extension error', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/throwing-tool/excalibur.extension.yaml',
      [
        'id: throwing-tool',
        'name: Throwing Tool',
        'version: 0.1.0',
        'kind: programmatic',
        'entrypoint: dist/index.js',
        '',
      ].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/extensions/throwing-tool/dist/index.js',
      `throw new Error('boom at require time');\n`,
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    const extension = registry.getExtension('throwing-tool');
    expect(extension?.status).toBe('error');
    expect(extension?.error).toContain('boom at require time');
  });

  it('records an entrypoint exporting the wrong shape as a per-extension error', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/odd-tool/excalibur.extension.yaml',
      [
        'id: odd-tool',
        'name: Odd Tool',
        'version: 0.1.0',
        'kind: programmatic',
        'entrypoint: dist/index.js',
        '',
      ].join('\n'),
    );
    write(repoRoot, '.excalibur/extensions/odd-tool/dist/index.js', 'module.exports = 42;\n');

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    const extension = registry.getExtension('odd-tool');
    expect(extension?.status).toBe('error');
    expect(extension?.error).toContain('defineExtension');
  });

  it('records an invalid local manifest as an error extension named after its directory', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/half-baked/excalibur.extension.yaml',
      'name: Missing id and kind\n',
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    const extension = registry.getExtension('half-baked');
    expect(extension?.status).toBe('error');
    expect(extension?.source).toBe('local');
    expect(extension?.error).toContain('Invalid extension manifest');
  });

  it('skips disabled extensions entirely (built-in and local)', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/internal-tool/excalibur.extension.yaml',
      [
        'id: internal-tool',
        'name: Internal Tool',
        'version: 0.1.0',
        'kind: programmatic',
        'entrypoint: dist/index.js',
        '',
      ].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/extensions/internal-tool/dist/index.js',
      `module.exports = { id: 'internal-tool', register() {} };\n`,
    );
    write(
      repoRoot,
      '.excalibur/extensions.yaml',
      'disabled:\n  - core-workflows\n  - internal-tool\n',
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    expect(registry.getExtension('core-workflows')).toBeUndefined();
    expect(registry.getExtension('internal-tool')).toBeUndefined();
    expect(registry.contributions.workflows()).toEqual([]);
    expect(registry.getExtension('core-methodologies')?.status).toBe('loaded');
  });

  it('warns when an id is both enabled and disabled — disabled wins', async () => {
    write(
      repoRoot,
      '.excalibur/extensions.yaml',
      'enabled:\n  - core-workflows\ndisabled:\n  - core-workflows\n',
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    expect(registry.getExtension('core-workflows')).toBeUndefined();
    const warnings = registry.contributions.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'core-workflows'");
    expect(warnings[0]).toContain('disabled');
  });

  it('records a broken extensions.yaml as a warning and keeps loading', async () => {
    write(repoRoot, '.excalibur/extensions.yaml', 'enabled: 42\n');

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    expect(registry.extensions().map((e) => e.manifest.id)).toEqual([
      'core-workflows',
      'core-methodologies',
    ]);
    expect(registry.contributions.warnings()[0]).toContain('extensions.yaml');
  });

  it('warns when a local entrypoint exports a different id than its manifest', async () => {
    write(
      repoRoot,
      '.excalibur/extensions/renamed/excalibur.extension.yaml',
      [
        'id: renamed',
        'name: Renamed',
        'version: 0.1.0',
        'kind: programmatic',
        'entrypoint: dist/index.js',
        '',
      ].join('\n'),
    );
    write(
      repoRoot,
      '.excalibur/extensions/renamed/dist/index.js',
      `module.exports = { id: 'something-else', register() {} };\n`,
    );

    const registry = await loadExtensions({ repoRoot, builtIns: BUILT_INS });
    expect(registry.getExtension('renamed')?.status).toBe('loaded');
    expect(
      registry.contributions.warnings().some((w) => w.includes("'something-else'")),
    ).toBe(true);
  });
});
