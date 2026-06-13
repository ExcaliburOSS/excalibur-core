import { describe, expect, it } from 'vitest';
import * as workflowSchema from './index';

describe('public API surface (Build Contract §4.2)', () => {
  it('exports every pinned name', () => {
    expect(workflowSchema.workflowPhaseSchema).toBeDefined();
    expect(workflowSchema.workflowDefinitionSchema).toBeDefined();
    expect(workflowSchema.methodologySchema).toBeDefined();
    expect(typeof workflowSchema.parseWorkflowYaml).toBe('function');
    expect(typeof workflowSchema.parseMethodologyYaml).toBe('function');
    expect(typeof workflowSchema.validateWorkflowDefinition).toBe('function');
    expect(typeof workflowSchema.validateMethodology).toBe('function');
    expect(workflowSchema.DEFAULT_WORKFLOWS).toHaveLength(14);
    expect(workflowSchema.DEFAULT_METHODOLOGIES).toHaveLength(14);
    expect(Object.keys(workflowSchema.DISCOVERY_QUESTION_PACKS)).toHaveLength(8);
    expect(typeof workflowSchema.getDefaultWorkflow).toBe('function');
    expect(typeof workflowSchema.getDefaultMethodology).toBe('function');
  });

  it('exposes yaml + definition for every catalog entry', () => {
    for (const entry of [...workflowSchema.DEFAULT_WORKFLOWS, ...workflowSchema.DEFAULT_METHODOLOGIES]) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.yaml).toBe('string');
      expect(entry.definition.id).toBe(entry.id);
    }
  });
});
