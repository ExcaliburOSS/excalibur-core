import { describe, expect, it } from 'vitest';
import { agentRoleSchema, DEFAULT_BLOCKED_PATHS } from '@excalibur/shared';
import {
  artifactTemplateSchema,
  commandMappingSchema,
  policyPresetSchema,
  promptTemplateSchema,
  roleDefinitionSchema,
} from '@excalibur/declarative-schemas';
import {
  CORE_COMMAND_MAPPINGS_PACK,
  CORE_POLICIES_PACK,
  CORE_PROMPTS_PACK,
  CORE_REPORTS_PACK,
  DISCOVERY_PACK,
  DISCOVERY_ROLE_DEFINITIONS,
  STANDARD_SAFE_BLOCKED_PATHS,
  STANDARD_SAFE_POLICY_PRESET,
  WORK_ITEM_COMMAND_MAPPING,
} from './index';

describe('discovery-pack roles', () => {
  it('publishes exactly the six frozen Discovery agent roles', () => {
    const roles = DISCOVERY_PACK.contributions.filter((c) => c.kind === 'role_definition');
    expect(roles.map((c) => c.id)).toEqual([
      'product_strategist',
      'customer_researcher',
      'discovery_reviewer',
      'ux_reviewer',
      'growth_reviewer',
      'scope_guardian',
    ]);
    for (const role of roles) {
      // Every role id must be a valid AgentRole from the frozen enum.
      expect(agentRoleSchema.safeParse(role.id).success).toBe(true);
      const definition = roleDefinitionSchema.parse(role.definition);
      expect(definition.id).toBe(role.id);
      expect(definition.name.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(20);
    }
    expect(DISCOVERY_ROLE_DEFINITIONS).toHaveLength(6);
  });
});

describe('discovery-pack artifact templates', () => {
  it('provides refined-ticket, mvp-scope and readiness-assessment with extracted variables', () => {
    const artifacts = DISCOVERY_PACK.contributions.filter((c) => c.kind === 'artifact_template');
    expect(artifacts.map((c) => c.id)).toEqual([
      'refined-ticket',
      'mvp-scope',
      'readiness-assessment',
    ]);
    for (const artifact of artifacts) {
      const definition = artifactTemplateSchema.parse(artifact.definition);
      expect(definition.variables.length).toBeGreaterThan(0);
      // Every declared variable appears as a {{placeholder}} in the body.
      for (const variable of definition.variables) {
        expect(definition.template).toContain(`{{${variable}}}`);
      }
    }
  });

  it('mirrors the Discovery spec §3 readiness card in readiness-assessment', () => {
    const artifact = DISCOVERY_PACK.contributions.find((c) => c.id === 'readiness-assessment');
    const definition = artifactTemplateSchema.parse(artifact?.definition);
    for (const variable of [
      'problemClarity',
      'userEvidence',
      'scopeClarity',
      'technicalRisk',
      'agentReadiness',
      'recommendedAutonomyLevel',
      'recommendedWorkflow',
      'recommendation',
      'reason',
    ]) {
      expect(definition.variables).toContain(variable);
    }
  });

  it('covers the refined-ticket structure of the Discovery spec', () => {
    const artifact = DISCOVERY_PACK.contributions.find((c) => c.id === 'refined-ticket');
    const definition = artifactTemplateSchema.parse(artifact?.definition);
    for (const section of [
      '## Problem',
      '## Expected behavior',
      '## Acceptance criteria',
      '## Scope',
      '## Out of scope',
      '## Implementation notes',
      '## Test expectations',
      '## Links',
    ]) {
      expect(definition.template).toContain(section);
    }
  });
});

describe('discovery-pack synthesis prompt', () => {
  it('ships a discovery-synthesis prompt that consumes input and transcript', () => {
    const prompt = DISCOVERY_PACK.contributions.find((c) => c.kind === 'prompt_template');
    expect(prompt?.id).toBe('discovery-synthesis');
    const definition = promptTemplateSchema.parse(prompt?.definition);
    expect(definition.template).toContain('{{input}}');
    expect(definition.template).toContain('{{transcript}}');
    expect(definition.template).toContain('{{inputType}}');
  });

  it('contains 18 contributions in total (8 packs + 6 roles + 3 artifacts + 1 prompt)', () => {
    expect(DISCOVERY_PACK.contributions).toHaveLength(18);
  });
});

describe('core-prompts', () => {
  it('provides pr-summary and code-review prompt templates', () => {
    expect(CORE_PROMPTS_PACK.contributions.map((c) => c.id)).toEqual([
      'pr-summary',
      'code-review',
    ]);
    for (const contribution of CORE_PROMPTS_PACK.contributions) {
      const definition = promptTemplateSchema.parse(contribution.definition);
      expect(definition.template).toContain('{{diff}}');
      expect(definition.template).toContain('{{task}}');
    }
  });
});

describe('core-policies standard-safe preset', () => {
  it('is the single policy_preset contribution of the pack', () => {
    expect(CORE_POLICIES_PACK.contributions).toHaveLength(1);
    const contribution = CORE_POLICIES_PACK.contributions[0];
    expect(contribution?.kind).toBe('policy_preset');
    expect(contribution?.id).toBe('standard-safe');
    expect(contribution?.definition).toBe(STANDARD_SAFE_POLICY_PRESET);
    expect(policyPresetSchema.safeParse(contribution?.definition).success).toBe(true);
  });

  it('builds its blocked paths from shared DEFAULT_BLOCKED_PATHS plus cert stores and .git', () => {
    for (const blocked of DEFAULT_BLOCKED_PATHS) {
      expect(STANDARD_SAFE_BLOCKED_PATHS).toContain(blocked);
    }
    // onboarding spec §5 additions over the OSS §17 defaults
    expect(STANDARD_SAFE_BLOCKED_PATHS).toContain('**/*.p12');
    expect(STANDARD_SAFE_BLOCKED_PATHS).toContain('**/*.pfx');
    expect(STANDARD_SAFE_BLOCKED_PATHS).toContain('.git/**');

    const blockedRule = STANDARD_SAFE_POLICY_PRESET.rules.find((r) => r.id === 'blocked-paths');
    expect(blockedRule?.decision).toBe('deny');
    expect(blockedRule?.when.filePathMatches).toEqual([...STANDARD_SAFE_BLOCKED_PATHS]);
  });

  it('encodes the onboarding §5 behavior: ask before mutations, never push, no network', () => {
    const decisionOf = (id: string) =>
      STANDARD_SAFE_POLICY_PRESET.rules.find((r) => r.id === id)?.decision;
    expect(decisionOf('read-files')).toBe('allow');
    expect(decisionOf('write-files')).toBe('require_approval');
    expect(decisionOf('apply-patch')).toBe('require_approval');
    expect(decisionOf('run-unknown-command')).toBe('require_approval');
    expect(decisionOf('create-branch')).toBe('require_approval');
    expect(decisionOf('open-pull-request')).toBe('require_approval');
    expect(decisionOf('git-push')).toBe('deny');
    expect(decisionOf('external-network')).toBe('deny');
    expect(decisionOf('redact-secrets-in-prompts')).toBe('redact');
    expect(decisionOf('redact-secrets-in-logs')).toBe('redact');
  });

  it('asks before running each detected project command', () => {
    for (const command of ['test', 'lint', 'typecheck', 'build']) {
      const rule = STANDARD_SAFE_POLICY_PRESET.rules.find(
        (r) => r.when.action === 'run_command' && r.when.command === command,
      );
      expect(rule?.decision, `command ${command}`).toBe('require_approval');
    }
  });
});

describe('core-reports', () => {
  it('provides daily-summary and weekly-plan report templates with the AA-8 sections', () => {
    expect(CORE_REPORTS_PACK.contributions.map((c) => c.id)).toEqual([
      'daily-summary',
      'weekly-plan',
    ]);
    const daily = CORE_REPORTS_PACK.contributions.find((c) => c.id === 'daily-summary');
    const dailyDefinition = daily?.definition as { sections: string[] };
    expect(dailyDefinition.sections).toEqual([
      'Completed runs',
      'Failed runs',
      'Patches',
      'Recent commits',
      'Pending items',
    ]);
    const weekly = CORE_REPORTS_PACK.contributions.find((c) => c.id === 'weekly-plan');
    const weeklyDefinition = weekly?.definition as { sections: string[] };
    expect(weeklyDefinition.sections.length).toBeGreaterThanOrEqual(3);
  });
});

describe('core-command-mappings work-item-commands', () => {
  it('is a single valid command_mapping contribution', () => {
    expect(CORE_COMMAND_MAPPINGS_PACK.contributions).toHaveLength(1);
    const contribution = CORE_COMMAND_MAPPINGS_PACK.contributions[0];
    expect(contribution?.kind).toBe('command_mapping');
    expect(contribution?.id).toBe('work-item-commands');
    expect(contribution?.definition).toBe(WORK_ITEM_COMMAND_MAPPING);
    expect(commandMappingSchema.safeParse(contribution?.definition).success).toBe(true);
  });

  it('mirrors the work-items spec §4 command → action table', () => {
    const byTrigger = new Map(
      WORK_ITEM_COMMAND_MAPPING.commands.map((entry) => [entry.trigger, entry]),
    );
    const expectations: Array<[string, string, Record<string, unknown> | undefined]> = [
      [
        '@excalibur refine',
        'interaction',
        { interactionType: 'work_item_refinement', autonomyLevel: 0 },
      ],
      ['@excalibur plan', 'interaction', { interactionType: 'work_item_plan', autonomyLevel: 0 }],
      [
        '@excalibur review',
        'interaction',
        { interactionType: 'work_item_review', autonomyLevel: 0 },
      ],
      ['@excalibur suggest-patch', 'patch', { variant: 'suggest_patch', autonomyLevel: 2 }],
      ['@excalibur generate-tests', 'patch', { variant: 'generate_tests', autonomyLevel: 2 }],
      ['@excalibur implement', 'run', { autonomyLevel: 3, executionStyle: 'team_default' }],
      ['@excalibur careful', 'run', { autonomyLevel: 4, executionStyle: 'careful' }],
      [
        '@excalibur explore',
        'run',
        { autonomyLevel: 3, executionStyle: 'explore', output: 'alternatives' },
      ],
      ['@excalibur status', 'status', undefined],
      ['@excalibur cancel', 'cancel', undefined],
      ['@excalibur daily', 'daily', undefined],
    ];
    for (const [trigger, action, defaults] of expectations) {
      const entry = byTrigger.get(trigger);
      expect(entry, `missing trigger ${trigger}`).toBeDefined();
      expect(entry?.action).toBe(action);
      if (defaults) {
        expect(entry?.defaults).toEqual(defaults);
      }
    }
  });

  it('covers the Agentic Agile planning vocabulary', () => {
    const planning = WORK_ITEM_COMMAND_MAPPING.commands.find(
      (entry) => entry.trigger === '@excalibur planning',
    );
    expect(planning?.action).toBe('planning');
    expect(planning?.defaults).toEqual({
      subcommands: [
        'start',
        'propose',
        'approve',
        'revise',
        'add',
        'remove',
        'owner',
        'careful',
        'run',
      ],
    });
  });

  it('covers the Discovery command vocabulary (discovery spec §7)', () => {
    const byTrigger = new Map(
      WORK_ITEM_COMMAND_MAPPING.commands.map((entry) => [entry.trigger, entry]),
    );
    const discovery = byTrigger.get('@excalibur discovery');
    expect(discovery?.action).toBe('discovery');
    expect(discovery?.defaults).toEqual({
      subcommands: ['complete', 'create-linear', 'update-ticket', 'create-run', 'save-decision'],
    });
    for (const trigger of [
      '@excalibur readiness',
      '@excalibur acceptance-criteria',
      '@excalibur split-scope',
    ]) {
      const entry = byTrigger.get(trigger);
      expect(entry?.action, trigger).toBe('discovery');
    }
    expect(WORK_ITEM_COMMAND_MAPPING.commands).toHaveLength(16);
  });
});
