import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METHODOLOGIES,
  DEFAULT_WORKFLOWS,
  type Methodology,
  type WorkflowDefinition,
} from '@excalibur/workflow-schema';
import { declarativeDefinitionSchema, declarativeSchemasByType } from './union';
import { DECLARATIVE_TYPES } from './types';

describe('declarativeSchemasByType', () => {
  it('has a schema for every declarative type', () => {
    for (const type of DECLARATIVE_TYPES) {
      expect(declarativeSchemasByType[type]).toBeDefined();
    }
  });
});

describe('declarativeDefinitionSchema', () => {
  it('dispatches every built-in workflow definition through the union', () => {
    expect(DEFAULT_WORKFLOWS.length).toBe(14);
    for (const entry of DEFAULT_WORKFLOWS) {
      const parsed = declarativeDefinitionSchema.parse({
        ...entry.definition,
        type: 'workflow',
      }) as WorkflowDefinition;
      expect(parsed.id).toBe(entry.id);
      expect(parsed.phases.length).toBeGreaterThan(0);
    }
  });

  it('dispatches every built-in methodology through the union', () => {
    expect(DEFAULT_METHODOLOGIES.length).toBe(14);
    for (const entry of DEFAULT_METHODOLOGIES) {
      const parsed = declarativeDefinitionSchema.parse({
        ...entry.definition,
        type: 'methodology',
      }) as Methodology;
      expect(parsed.id).toBe(entry.id);
      expect(parsed.description.length).toBeGreaterThan(0);
    }
  });

  it('dispatches each of the eight package-owned types', () => {
    const fixtures: Array<Record<string, unknown>> = [
      {
        id: 'pack',
        type: 'question_pack',
        name: 'Pack',
        questions: [{ id: 'q1', text: 'Why?' }],
      },
      { id: 'prompt', type: 'prompt_template', name: 'Prompt', template: 'Do {{thing}}.' },
      { id: 'artifact', type: 'artifact_template', template: '# {{title}}' },
      {
        id: 'preset',
        type: 'policy_preset',
        rules: [{ id: 'r1', when: { action: 'write_file' }, decision: 'require_approval' }],
      },
      { id: 'routing', type: 'model_routing', default: 'mock' },
      { id: 'report', type: 'report_template', name: 'Report', sections: ['summary'] },
      { id: 'role', type: 'role_definition', name: 'Role', description: 'A role.' },
      {
        id: 'mapping',
        type: 'command_mapping',
        commands: [{ trigger: '@excalibur run', action: 'run' }],
      },
    ];
    for (const fixture of fixtures) {
      const parsed = declarativeDefinitionSchema.parse(fixture);
      expect(parsed.type).toBe(fixture.type);
      expect(parsed.id).toBe(fixture.id);
    }
  });

  it('applies the member transform (artifact variables) through the union', () => {
    const parsed = declarativeDefinitionSchema.parse({
      id: 'refined-ticket',
      type: 'artifact_template',
      template: '# {{title}}\n{{problem}}',
    });
    expect(parsed.type).toBe('artifact_template');
    if (parsed.type === 'artifact_template') {
      expect(parsed.variables).toEqual(['title', 'problem']);
    }
  });

  it('rejects a definition without a type, naming the valid types', () => {
    const result = declarativeDefinitionSchema.safeParse({ id: 'mystery' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue?.path).toEqual(['type']);
      expect(issue?.message).toContain('missing "type"');
      expect(issue?.message).toContain('question_pack');
    }
  });

  it('rejects an unknown type with a readable message', () => {
    const result = declarativeDefinitionSchema.safeParse({ id: 'x', type: 'gizmo' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('unknown declarative type "gizmo"');
    }
  });

  it('reports only the selected member schema issues', () => {
    const result = declarativeDefinitionSchema.safeParse({
      id: 'pack',
      type: 'question_pack',
      name: 'Pack',
      questions: [{ id: 'q1' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.path).toEqual(['questions', 0, 'text']);
    }
  });

  it('rejects non-object values with a readable message', () => {
    for (const value of [null, 42, 'workflow', ['list']]) {
      const result = declarativeDefinitionSchema.safeParse(value);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          'expected a declarative definition object',
        );
      }
    }
  });
});
