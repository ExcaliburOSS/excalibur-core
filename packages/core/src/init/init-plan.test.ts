import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeRepository, type RepoAnalysis } from '@excalibur/context-engine';
import { BUILT_IN_EXTENSIONS } from '@excalibur/built-in-extensions';
import { excaliburConfigSchema } from '@excalibur/shared';
import { DEFAULT_METHODOLOGIES, DEFAULT_WORKFLOWS } from '@excalibur/workflow-schema';
import { demoRepoDir, fakeAnalysis, makeTempDir, removeDir } from '../test-utils';
import { applyInitPlan, generateInitPlan } from './init-plan';
import type { InstructionSource } from '@excalibur/shared';

const DEMO_REPO = demoRepoDir();

describe('generateInitPlan (examples/demo-repo)', () => {
  let analysis: RepoAnalysis;

  beforeEach(async () => {
    analysis = await analyzeRepository(DEMO_REPO);
  });

  it('minimal mode generates exactly config.yaml, instructions/general.md and extensions.yaml', () => {
    const plan = generateInitPlan(analysis, { mode: 'minimal' });
    expect(plan.files.map((file) => file.relPath).sort()).toEqual([
      '.excalibur/config.yaml',
      '.excalibur/extensions.yaml',
      '.excalibur/instructions/general.md',
    ]);
    expect(plan.files.every((file) => !file.exists)).toBe(true);
  });

  it('writes detected commands and project facts into config.yaml — never invented', () => {
    const plan = generateInitPlan(analysis, { mode: 'minimal' });
    const configFile = plan.files.find((file) => file.relPath === '.excalibur/config.yaml');
    const parsed = parseYaml(configFile?.content ?? '') as Record<string, unknown>;

    // The generated config must validate against the shared schema.
    expect(excaliburConfigSchema.safeParse(parsed).success).toBe(true);

    const commands = parsed['commands'] as Record<string, string>;
    expect(commands['test']).toBe('pnpm test');
    expect(commands['lint']).toBe('pnpm run lint');
    expect(commands['typecheck']).toBe('pnpm run typecheck');
    expect(commands['build']).toBe('pnpm run build');

    const project = parsed['project'] as Record<string, unknown>;
    expect(project['name']).toBe('quickcontract-api');
    expect(project['packageManager']).toBe('pnpm');
    expect(project['languages']).toContain('typescript');

    expect((parsed['safety'] as Record<string, unknown>)['preset']).toBe('standard-safe');
    const workflowDefaults = parsed['workflowDefaults'] as Record<string, string>;
    expect(workflowDefaults['ask']).toBe('ask-repo');
    expect(workflowDefaults['discovery']).toBe('discovery');
  });

  it('references detected instruction sources and skills (skills not auto-enabled)', () => {
    const plan = generateInitPlan(analysis, { mode: 'minimal' });
    const configFile = plan.files.find((file) => file.relPath === '.excalibur/config.yaml');
    const parsed = parseYaml(configFile?.content ?? '') as {
      instructions?: { sources?: Array<Record<string, unknown>> };
      skills?: { sources?: Array<Record<string, unknown>> };
    };

    const instructionPaths = (parsed.instructions?.sources ?? []).map((entry) => entry['path']);
    expect(instructionPaths).toContain('./CLAUDE.md');
    expect(instructionPaths).toContain('./AGENTS.md');
    // Only detected references — never non-existent paths.
    for (const path of instructionPaths) {
      expect(existsSync(join(DEMO_REPO, String(path)))).toBe(true);
    }

    const skillSources = parsed.skills?.sources ?? [];
    expect(skillSources.length).toBeGreaterThan(0);
    const testingSkill = skillSources.find((entry) =>
      String(entry['path']).includes('.claude/skills/testing/SKILL.md'),
    );
    expect(testingSkill).toBeDefined();
    expect(testingSkill?.['enabled']).toBe(false);
    expect(testingSkill?.['trustLevel']).toBe('review_required');
  });

  it('prints the grouped detection report in summaryLines', () => {
    const plan = generateInitPlan(analysis, { mode: 'minimal' });
    const summary = plan.summaryLines.join('\n');
    expect(summary).toContain('Detected:');
    expect(summary).toContain('pnpm');
    expect(summary).toContain('CLAUDE.md');
    expect(summary).toContain('Detected skills');
    expect(summary).toContain('standard-safe');
    expect(summary).toContain('.excalibur/config.yaml');
  });

  it('enables every built-in pack id in extensions.yaml', () => {
    const plan = generateInitPlan(analysis, { mode: 'minimal' });
    const extensionsFile = plan.files.find((file) => file.relPath === '.excalibur/extensions.yaml');
    const parsed = parseYaml(extensionsFile?.content ?? '') as { enabled: string[] };
    expect(parsed.enabled).toEqual(BUILT_IN_EXTENSIONS.map((pack) => pack.manifest.id));
  });

  it('team mode adds instruction stubs, policies and model files', () => {
    const plan = generateInitPlan(analysis, { mode: 'team' });
    const paths = plan.files.map((file) => file.relPath);
    expect(paths).toContain('.excalibur/instructions/architecture.md');
    expect(paths).toContain('.excalibur/instructions/testing.md');
    expect(paths).toContain('.excalibur/instructions/documentation.md');
    expect(paths).toContain('.excalibur/instructions/security.md');
    expect(paths).toContain('.excalibur/policies/standard-safe.yaml');
    expect(paths).toContain('.excalibur/policies/sensitive-paths.yaml');
    expect(paths).toContain('.excalibur/models/providers.yaml');
    expect(paths).toContain('.excalibur/models/routing.yaml');

    const providers = plan.files.find((file) => file.relPath === '.excalibur/models/providers.yaml');
    const parsed = parseYaml(providers?.content ?? '') as {
      providers: { default: string; mock: { type: string } };
    };
    expect(parsed.providers.default).toBe('mock');
    expect(parsed.providers.mock.type).toBe('mock');
  });

  it('full mode exports all 14 workflows, 14 methodologies and the other catalogs', () => {
    const plan = generateInitPlan(analysis, { mode: 'full' });
    const paths = plan.files.map((file) => file.relPath);

    for (const workflow of DEFAULT_WORKFLOWS) {
      expect(paths).toContain(`.excalibur/workflows/${workflow.id}.yaml`);
    }
    for (const methodology of DEFAULT_METHODOLOGIES) {
      expect(paths).toContain(`.excalibur/methodologies/${methodology.id}.yaml`);
    }
    expect(paths.filter((path) => path.startsWith('.excalibur/question-packs/')).length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('.excalibur/prompts/')).length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('.excalibur/artifacts/')).length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('.excalibur/reports/')).length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('.excalibur/roles/')).length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith('.excalibur/command-mappings/')).length).toBeGreaterThan(0);
    expect(paths).toContain('.excalibur/memory/decisions.md');
    expect(paths).toContain('.excalibur/memory/known-risks.md');
    expect(paths).toContain('.excalibur/memory/domain-glossary.md');

    // Exported workflow files are the authored YAML sources.
    const fastFix = plan.files.find((file) => file.relPath === '.excalibur/workflows/fast-fix.yaml');
    expect(fastFix?.content).toContain('id: fast-fix');
  });
});

describe('applyInitPlan', () => {
  let repoRoot: string;
  let analysis: RepoAnalysis;

  beforeEach(async () => {
    repoRoot = makeTempDir();
    analysis = await analyzeRepository(DEMO_REPO);
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('writes the planned files and never overwrites silently', () => {
    const plan = generateInitPlan(analysis, { mode: 'minimal' });

    const first = applyInitPlan(repoRoot, plan, { overwrite: false });
    expect(first.written.sort()).toEqual(plan.files.map((file) => file.relPath).sort());
    expect(first.skipped).toEqual([]);
    expect(existsSync(join(repoRoot, '.excalibur', 'config.yaml'))).toBe(true);

    // Second run without overwrite: everything is skipped (update mode).
    const second = applyInitPlan(repoRoot, plan, { overwrite: false });
    expect(second.written).toEqual([]);
    expect(second.skipped.sort()).toEqual(plan.files.map((file) => file.relPath).sort());

    // Overwrite rewrites the files.
    const third = applyInitPlan(repoRoot, plan, { overwrite: true });
    expect(third.written.length).toBe(plan.files.length);
    const content = readFileSync(join(repoRoot, '.excalibur', 'config.yaml'), 'utf8');
    expect(content).toContain('quickcontract-api');
  });

  it('full-mode files load cleanly through the extension host as project overrides', async () => {
    const { createExtensionHost } = await import('../extensions/host');
    const plan = generateInitPlan(analysis, { mode: 'full' });
    applyInitPlan(repoRoot, plan, { overwrite: false });

    const registry = await createExtensionHost(repoRoot);

    // Every exported declarative file validated; none was rejected.
    const invalid = registry.contributions
      .warnings()
      .filter((warning) => warning.includes('invalid') || warning.includes('Failed to load'));
    expect(invalid).toEqual([]);

    // Project files override the built-ins with the same ids.
    expect(registry.contributions.get('workflow', 'fast-fix')?.source).toBe('project');
    expect(registry.contributions.get('methodology', 'discovery')?.source).toBe('project');
    expect(registry.contributions.get('policy_preset', 'standard-safe')?.source).toBe('project');
    expect(registry.contributions.workflows()).toHaveLength(DEFAULT_WORKFLOWS.length);
    expect(registry.contributions.methodologies()).toHaveLength(DEFAULT_METHODOLOGIES.length);
  });

  it('marks existing files in a regenerated plan (update mode)', async () => {
    const plan = generateInitPlan(analysis, { mode: 'minimal' });
    applyInitPlan(repoRoot, plan, { overwrite: false });

    const updated = generateInitPlan(await analyzeRepository(DEMO_REPO), { mode: 'minimal' });
    // exists is computed against analysis.root (the demo repo has no .excalibur)
    expect(updated.files.every((file) => !file.exists)).toBe(true);

    const applied = applyInitPlan(repoRoot, updated, { overwrite: false });
    expect(applied.skipped.length).toBe(updated.files.length);
  });
});

describe('generateInitPlan — root AGENTS.md generation', () => {
  function agentsMdSource(): InstructionSource {
    return {
      id: 'agents-project',
      scope: 'project',
      format: 'agents_md',
      kind: 'instruction',
      path: 'AGENTS.md',
      title: null,
      contentHash: 'deadbeef',
      trustLevel: 'trusted',
      enabled: true,
      importedAs: 'instruction',
      metadata: {},
    };
  }

  it('generates a root AGENTS.md when the repo has none', () => {
    const plan = generateInitPlan(fakeAnalysis(), { mode: 'minimal' });
    const agents = plan.files.find((file) => file.relPath === 'AGENTS.md');
    expect(agents).toBeDefined();
    expect(agents?.exists).toBe(false);
    // Cross-tool standard content, filled from the analysis.
    expect(agents?.content).toContain('# fake-repo');
    expect(agents?.content).toContain('cross-tool standard');
    expect(agents?.content).toContain('## Commands');
    expect(agents?.content).toContain('pnpm test');
    // Documentation is a default convention, on par with testing.
    expect(agents?.content).toContain('Update the relevant documentation');
    expect(agents?.content).toContain('## Sensitive areas');
    expect(plan.summaryLines.some((line) => line.includes('Bootstrapping AGENTS.md'))).toBe(true);
  });

  it('never generates AGENTS.md when one already exists (respects ISD)', () => {
    const analysis = fakeAnalysis({ instructionSources: [agentsMdSource()] });
    const plan = generateInitPlan(analysis, { mode: 'minimal' });
    expect(plan.files.some((file) => file.relPath === 'AGENTS.md')).toBe(false);
    expect(plan.summaryLines.some((line) => line.includes('Bootstrapping AGENTS.md'))).toBe(false);
  });

  it('generates AGENTS.md in team and full modes too when absent', () => {
    for (const mode of ['team', 'full'] as const) {
      const plan = generateInitPlan(fakeAnalysis(), { mode });
      expect(plan.files.some((file) => file.relPath === 'AGENTS.md')).toBe(true);
    }
  });
});
