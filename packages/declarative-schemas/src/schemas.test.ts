import { describe, expect, it } from 'vitest';
import {
  artifactTemplateSchema,
  commandMappingSchema,
  extractTemplateVariables,
  modelRoutingSchema,
  policyPresetSchema,
  promptTemplateSchema,
  questionPackSchema,
  reportTemplateSchema,
  roleDefinitionSchema,
} from './schemas';
import { DECLARATIVE_TYPES, isDeclarativeType } from './types';

describe('DECLARATIVE_TYPES', () => {
  it('lists exactly the 10 declarative types of the extensions spec', () => {
    expect(DECLARATIVE_TYPES).toEqual([
      'methodology',
      'workflow',
      'question_pack',
      'prompt_template',
      'artifact_template',
      'policy_preset',
      'model_routing',
      'report_template',
      'role_definition',
      'command_mapping',
    ]);
  });

  it('isDeclarativeType narrows correctly', () => {
    expect(isDeclarativeType('question_pack')).toBe(true);
    expect(isDeclarativeType('workflow')).toBe(true);
    expect(isDeclarativeType('gizmo')).toBe(false);
    expect(isDeclarativeType(42)).toBe(false);
    expect(isDeclarativeType(undefined)).toBe(false);
  });
});

describe('questionPackSchema', () => {
  it('parses a valid question pack', () => {
    const result = questionPackSchema.parse({
      id: 'agent-readiness',
      type: 'question_pack',
      name: 'Agent Readiness',
      questions: [
        { id: 'problem', text: 'Is the goal clear enough for an agent?' },
        { id: 'acceptance', text: 'Are acceptance criteria present?' },
      ],
    });
    expect(result.id).toBe('agent-readiness');
    expect(result.questions).toHaveLength(2);
  });

  it('rejects an empty questions list with a readable message', () => {
    const result = questionPackSchema.safeParse({
      id: 'empty',
      type: 'question_pack',
      name: 'Empty',
      questions: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('at least one question');
    }
  });

  it('rejects a question without text, pointing at the path', () => {
    const result = questionPackSchema.safeParse({
      id: 'bad',
      type: 'question_pack',
      name: 'Bad',
      questions: [{ id: 'q1' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['questions', 0, 'text']);
    }
  });
});

describe('promptTemplateSchema', () => {
  it('parses a valid prompt template', () => {
    const result = promptTemplateSchema.parse({
      id: 'discovery-synthesis',
      type: 'prompt_template',
      name: 'Discovery Synthesis',
      template: 'Synthesize the discovery transcript into a refined ticket.',
    });
    expect(result.template).toContain('Synthesize');
  });

  it('requires a non-empty template body', () => {
    const result = promptTemplateSchema.safeParse({
      id: 'empty',
      type: 'prompt_template',
      name: 'Empty',
      template: '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('must not be empty');
    }
  });
});

describe('extractTemplateVariables', () => {
  it('extracts variables in order of first appearance', () => {
    expect(extractTemplateVariables('# {{title}}\n\n{{problem}}\n{{acceptance}}')).toEqual([
      'title',
      'problem',
      'acceptance',
    ]);
  });

  it('deduplicates repeated placeholders', () => {
    expect(extractTemplateVariables('{{user}} and again {{user}}')).toEqual(['user']);
  });

  it('tolerates inner whitespace', () => {
    expect(extractTemplateVariables('Hello {{ user }}!')).toEqual(['user']);
  });

  it('supports dotted and dashed names', () => {
    expect(extractTemplateVariables('{{scores.clarity}} / {{ticket-id}}')).toEqual([
      'scores.clarity',
      'ticket-id',
    ]);
  });

  it('returns an empty list when there are no placeholders', () => {
    expect(extractTemplateVariables('No variables here.')).toEqual([]);
  });

  it('ignores malformed placeholders', () => {
    expect(extractTemplateVariables('{{}} {single} {{ }}')).toEqual([]);
  });
});

describe('artifactTemplateSchema', () => {
  it('auto-extracts variables from {{...}} placeholders', () => {
    const result = artifactTemplateSchema.parse({
      id: 'refined-ticket',
      type: 'artifact_template',
      name: 'Refined Ticket',
      template: '# {{title}}\n\n## Problem\n{{problem}}\n\n## Criteria\n{{acceptance_criteria}}',
    });
    expect(result.variables).toEqual(['title', 'problem', 'acceptance_criteria']);
  });

  it('keeps declared variables that are not in the template, after extracted ones', () => {
    const result = artifactTemplateSchema.parse({
      id: 'mvp-scope',
      type: 'artifact_template',
      template: '## Scope\n{{scope}}',
      variables: ['scope', 'reviewer'],
    });
    expect(result.variables).toEqual(['scope', 'reviewer']);
  });

  it('allows the name to be omitted', () => {
    const result = artifactTemplateSchema.parse({
      id: 'readiness-assessment',
      type: 'artifact_template',
      template: 'Readiness: {{readiness}}',
    });
    expect(result.name).toBeUndefined();
    expect(result.variables).toEqual(['readiness']);
  });

  it('rejects an empty template', () => {
    const result = artifactTemplateSchema.safeParse({
      id: 'empty',
      type: 'artifact_template',
      template: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('policyPresetSchema', () => {
  it('parses rules with all condition kinds and all four decisions', () => {
    const result = policyPresetSchema.parse({
      id: 'standard-safe',
      type: 'policy_preset',
      rules: [
        {
          id: 'block-secrets',
          when: { filePathMatches: ['.env', '**/*.pem'], action: 'read' },
          decision: 'deny',
        },
        { id: 'ask-before-write', when: { action: 'write_file' }, decision: 'require_approval' },
        { id: 'allow-tests', when: { command: 'pnpm test' }, decision: 'allow' },
        { id: 'redact-prompts', when: { action: 'prompt' }, decision: 'redact' },
      ],
    });
    expect(result.rules).toHaveLength(4);
    expect(result.rules[0]?.when.filePathMatches).toContain('**/*.pem');
  });

  it('rejects an unknown decision value, pointing at the rule', () => {
    const result = policyPresetSchema.safeParse({
      id: 'bad',
      type: 'policy_preset',
      rules: [{ id: 'r1', when: {}, decision: 'maybe' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['rules', 0, 'decision']);
    }
  });

  it('requires at least one rule', () => {
    const result = policyPresetSchema.safeParse({
      id: 'empty',
      type: 'policy_preset',
      rules: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('at least one rule');
    }
  });
});

describe('modelRoutingSchema', () => {
  it('parses default/byRole/byPath/byWorkflow routing', () => {
    const result = modelRoutingSchema.parse({
      id: 'default-routing',
      type: 'model_routing',
      default: 'mock',
      byRole: { planner: 'mock', implementer: 'mock' },
      byPath: { 'src/billing/**': 'careful-model' },
      byWorkflow: { 'security-review': 'careful-model' },
    });
    expect(result.default).toBe('mock');
    expect(result.byPath?.['src/billing/**']).toBe('careful-model');
  });

  it('parses with every routing field omitted', () => {
    const result = modelRoutingSchema.parse({ id: 'noop', type: 'model_routing' });
    expect(result.default).toBeUndefined();
    expect(result.byRole).toBeUndefined();
  });
});

describe('reportTemplateSchema', () => {
  it('parses a report template with sections', () => {
    const result = reportTemplateSchema.parse({
      id: 'daily-summary',
      type: 'report_template',
      name: 'Daily Summary',
      sections: ['completed_runs', 'failed_runs', 'patches', 'pending_items'],
    });
    expect(result.sections).toHaveLength(4);
  });

  it('requires at least one section', () => {
    const result = reportTemplateSchema.safeParse({
      id: 'empty',
      type: 'report_template',
      name: 'Empty',
      sections: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('at least one section');
    }
  });
});

describe('roleDefinitionSchema', () => {
  it('parses a role definition', () => {
    const result = roleDefinitionSchema.parse({
      id: 'product-strategist',
      type: 'role_definition',
      name: 'Product Strategist',
      description: 'Challenges assumptions about user value during discovery.',
    });
    expect(result.name).toBe('Product Strategist');
  });

  it('requires a description', () => {
    const result = roleDefinitionSchema.safeParse({
      id: 'scope-guardian',
      type: 'role_definition',
      name: 'Scope Guardian',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['description']);
    }
  });
});

describe('commandMappingSchema', () => {
  it('parses trigger/action/defaults command entries', () => {
    const result = commandMappingSchema.parse({
      id: 'work-item-commands',
      type: 'command_mapping',
      commands: [
        {
          trigger: '@excalibur refine',
          action: 'work_item_refinement',
          defaults: { autonomyLevel: 0 },
        },
        {
          trigger: '@excalibur run',
          action: 'run',
          defaults: { autonomyLevel: 3, executionStyle: 'team_default' },
        },
      ],
    });
    expect(result.commands).toHaveLength(2);
    expect(result.commands[1]?.defaults?.executionStyle).toBe('team_default');
  });

  it('allows defaults to be omitted', () => {
    const result = commandMappingSchema.parse({
      id: 'status-only',
      type: 'command_mapping',
      commands: [{ trigger: '@excalibur status', action: 'status' }],
    });
    expect(result.commands[0]?.defaults).toBeUndefined();
  });

  it('rejects a command without a trigger, pointing at the path', () => {
    const result = commandMappingSchema.safeParse({
      id: 'bad',
      type: 'command_mapping',
      commands: [{ action: 'run' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['commands', 0, 'trigger']);
    }
  });
});
