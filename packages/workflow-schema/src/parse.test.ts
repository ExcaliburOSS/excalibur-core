import { describe, expect, it } from 'vitest';
import { WorkflowValidationError } from '@excalibur/shared';
import {
  parseMethodologyYaml,
  parseWorkflowYaml,
  validateMethodology,
  validateWorkflowDefinition,
} from './parse';

const validWorkflowYaml = `id: demo
name: Demo
mode: fast
phases:
  - id: answer
    name: Answer
    type: assistant_interaction
    role: planner
`;

const validMethodologyYaml = `id: demo
name: Demo
description: A demo methodology.
`;

describe('parseWorkflowYaml', () => {
  it('parses a valid workflow', () => {
    const definition = parseWorkflowYaml(validWorkflowYaml);
    expect(definition.id).toBe('demo');
    expect(definition.supportedAutonomyLevels).toEqual([0, 1, 2, 3, 4]);
    expect(definition.phases[0]?.required).toBe(true);
  });

  it('throws WorkflowValidationError on YAML syntax errors', () => {
    expect(() => parseWorkflowYaml('id: [unclosed')).toThrow(WorkflowValidationError);
    try {
      parseWorkflowYaml('id: [unclosed');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      expect((error as WorkflowValidationError).message).toContain('YAML');
      expect((error as WorkflowValidationError).code).toBe('workflow_validation');
    }
  });

  it('throws on non-mapping YAML documents', () => {
    expect(() => parseWorkflowYaml('just a string')).toThrow(WorkflowValidationError);
    expect(() => parseWorkflowYaml('- a\n- list')).toThrow(/expected a YAML mapping/);
  });

  it('reports the offending path and problem in a readable message', () => {
    const invalid = `id: demo
name: Demo
mode: fast
phases:
  - id: answer
    name: Answer
    type: not_a_phase_type
`;
    try {
      parseWorkflowYaml(invalid);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('workflow definition "demo"');
      expect(message).toContain('phases[0].type');
    }
  });

  it('reports missing required fields', () => {
    expect(() => parseWorkflowYaml('name: No Id\nmode: fast\nphases: []')).toThrow(/id/);
  });
});

describe('parseMethodologyYaml', () => {
  it('parses a valid methodology and fills defaults', () => {
    const methodology = parseMethodologyYaml(validMethodologyYaml);
    expect(methodology.id).toBe('demo');
    expect(methodology.category).toBe('delivery');
    expect(methodology.riskProfile).toBe('medium');
  });

  it('throws a readable error for invalid fields', () => {
    const invalid = `id: demo
name: Demo
description: A demo methodology.
riskProfile: extreme
`;
    try {
      parseMethodologyYaml(invalid);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('methodology definition "demo"');
      expect(message).toContain('riskProfile');
    }
  });

  it('throws on YAML syntax errors', () => {
    expect(() => parseMethodologyYaml('id: {')).toThrow(WorkflowValidationError);
  });
});

describe('validateWorkflowDefinition', () => {
  it('returns data on success', () => {
    const result = validateWorkflowDefinition({
      id: 'demo',
      name: 'Demo',
      mode: 'fast',
      phases: [{ id: 'p', name: 'P', type: 'agent_output' }],
    });
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('demo');
    expect(result.errors).toBeUndefined();
  });

  it('returns readable errors on failure', () => {
    const result = validateWorkflowDefinition({ id: 'demo', name: 'Demo', mode: 'warp' });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.errors).toBeDefined();
    expect(result.errors?.some((line) => line.startsWith('mode:'))).toBe(true);
    expect(result.errors?.some((line) => line.startsWith('phases:'))).toBe(true);
  });

  it('reports a root-level error for non-object input', () => {
    const result = validateWorkflowDefinition(42);
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain('(root)');
  });
});

describe('validateMethodology', () => {
  it('returns data on success', () => {
    const result = validateMethodology({ id: 'm', name: 'M', description: 'd' });
    expect(result.success).toBe(true);
    expect(result.data?.category).toBe('delivery');
  });

  it('returns errors on failure', () => {
    const result = validateMethodology({ id: 'm', name: 'M' });
    expect(result.success).toBe(false);
    expect(result.errors?.some((line) => line.startsWith('description:'))).toBe(true);
  });
});
