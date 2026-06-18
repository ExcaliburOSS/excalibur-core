import { describe, expect, it } from 'vitest';
import {
  methodologySchema,
  workflowDefinitionSchema,
  workflowPhaseSchema,
} from './schema';

const minimalPhase = { id: 'review', name: 'Review', type: 'agent_review' } as const;

const minimalWorkflow = {
  id: 'demo',
  name: 'Demo',
  mode: 'fast',
  phases: [minimalPhase],
} as const;

const minimalMethodology = {
  id: 'demo',
  name: 'Demo',
  description: 'A demo methodology.',
} as const;

describe('workflowPhaseSchema', () => {
  it('defaults required to true and onFailure to abort', () => {
    const phase = workflowPhaseSchema.parse(minimalPhase);
    expect(phase.required).toBe(true);
    expect(phase.onFailure).toBe('abort');
  });

  it('normalizes optional: true to required: false', () => {
    const phase = workflowPhaseSchema.parse({ ...minimalPhase, optional: true });
    expect(phase.required).toBe(false);
    expect(phase.optional).toBe(true);
  });

  it("accepts agents: 'auto' (swarm auto-sizing) and a numeric override + parallelism", () => {
    const auto = workflowPhaseSchema.parse({ ...minimalPhase, agents: 'auto', parallelism: 'parallel' });
    expect(auto.agents).toBe('auto');
    expect(auto.parallelism).toBe('parallel');
    const capped = workflowPhaseSchema.parse({ ...minimalPhase, agents: 3 });
    expect(capped.agents).toBe(3);
  });

  it('rejects agents: 0 and an unknown parallelism', () => {
    expect(() => workflowPhaseSchema.parse({ ...minimalPhase, agents: 0 })).toThrow();
    expect(() => workflowPhaseSchema.parse({ ...minimalPhase, parallelism: 'concurrent' })).toThrow();
  });

  it('keeps an explicit required: false', () => {
    const phase = workflowPhaseSchema.parse({ ...minimalPhase, required: false });
    expect(phase.required).toBe(false);
  });

  it('rejects a phase declared both required:true and optional:true', () => {
    expect(
      workflowPhaseSchema.safeParse({ ...minimalPhase, required: true, optional: true }).success,
    ).toBe(false);
    // The non-contradictory combos still parse.
    expect(workflowPhaseSchema.safeParse({ ...minimalPhase, optional: true }).success).toBe(true);
    expect(workflowPhaseSchema.safeParse({ ...minimalPhase, required: true }).success).toBe(true);
  });

  it('preserves explicit onFailure and maxRetries', () => {
    const phase = workflowPhaseSchema.parse({
      ...minimalPhase,
      onFailure: 'retry',
      maxRetries: 2,
    });
    expect(phase.onFailure).toBe('retry');
    expect(phase.maxRetries).toBe(2);
  });

  it('rejects unknown phase types and roles', () => {
    expect(workflowPhaseSchema.safeParse({ ...minimalPhase, type: 'dance' }).success).toBe(false);
    expect(workflowPhaseSchema.safeParse({ ...minimalPhase, role: 'wizard' }).success).toBe(false);
  });

  it('rejects invalid approval values', () => {
    expect(
      workflowPhaseSchema.safeParse({ ...minimalPhase, approval: 'mandatory' }).success,
    ).toBe(false);
  });
});

describe('workflowDefinitionSchema', () => {
  it('defaults supportedAutonomyLevels to all levels', () => {
    const definition = workflowDefinitionSchema.parse(minimalWorkflow);
    expect(definition.supportedAutonomyLevels).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps declared supportedAutonomyLevels', () => {
    const definition = workflowDefinitionSchema.parse({
      ...minimalWorkflow,
      supportedAutonomyLevels: [2, 3],
    });
    expect(definition.supportedAutonomyLevels).toEqual([2, 3]);
  });

  it('accepts the optional type discriminator only as "workflow"', () => {
    expect(
      workflowDefinitionSchema.safeParse({ ...minimalWorkflow, type: 'workflow' }).success,
    ).toBe(true);
    expect(
      workflowDefinitionSchema.safeParse({ ...minimalWorkflow, type: 'methodology' }).success,
    ).toBe(false);
  });

  it('accepts inputs and defaults', () => {
    const definition = workflowDefinitionSchema.parse({
      ...minimalWorkflow,
      inputs: ['task'],
      defaults: { model: 'mock', commands: ['pnpm test'] },
    });
    expect(definition.inputs).toEqual(['task']);
    expect(definition.defaults).toEqual({ model: 'mock', commands: ['pnpm test'] });
  });

  it('requires at least one phase', () => {
    const result = workflowDefinitionSchema.safeParse({ ...minimalWorkflow, phases: [] });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate phase ids (events are attributed by phase id)', () => {
    const result = workflowDefinitionSchema.safeParse({
      ...minimalWorkflow,
      phases: [
        { id: 'p', name: 'One', type: 'agent_review' },
        { id: 'p', name: 'Two', type: 'agent_work' },
      ],
    });
    expect(result.success).toBe(false);
    // Distinct ids are fine.
    expect(
      workflowDefinitionSchema.safeParse({
        ...minimalWorkflow,
        phases: [
          { id: 'a', name: 'One', type: 'agent_review' },
          { id: 'b', name: 'Two', type: 'agent_work' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects out-of-range autonomy levels', () => {
    const result = workflowDefinitionSchema.safeParse({
      ...minimalWorkflow,
      supportedAutonomyLevels: [5],
    });
    expect(result.success).toBe(false);
  });

  it('normalizes nested phases', () => {
    const definition = workflowDefinitionSchema.parse({
      ...minimalWorkflow,
      phases: [{ ...minimalPhase, optional: true }],
    });
    expect(definition.phases[0]?.required).toBe(false);
  });
});

describe('methodologySchema', () => {
  it('defaults category to delivery and riskProfile to medium', () => {
    const methodology = methodologySchema.parse(minimalMethodology);
    expect(methodology.category).toBe('delivery');
    expect(methodology.riskProfile).toBe('medium');
  });

  it('keeps declared category and riskProfile', () => {
    const methodology = methodologySchema.parse({
      ...minimalMethodology,
      category: 'pre_work',
      riskProfile: 'low',
    });
    expect(methodology.category).toBe('pre_work');
    expect(methodology.riskProfile).toBe('low');
  });

  it('accepts the optional type discriminator only as "methodology"', () => {
    expect(
      methodologySchema.safeParse({ ...minimalMethodology, type: 'methodology' }).success,
    ).toBe(true);
    expect(
      methodologySchema.safeParse({ ...minimalMethodology, type: 'workflow' }).success,
    ).toBe(false);
  });

  it('requires a description', () => {
    expect(methodologySchema.safeParse({ id: 'demo', name: 'Demo' }).success).toBe(false);
  });

  it('accepts the richer fields', () => {
    const methodology = methodologySchema.parse({
      ...minimalMethodology,
      recommendedAutonomyLevels: [0, 1],
      useWhen: ['Ambiguity'],
      avoidWhen: ['Urgency'],
      defaultWorkflow: 'assist',
      workflows: ['assist'],
      phases: ['question'],
      artifacts: ['answer.md'],
      outputs: ['answer.md'],
      modes: ['product_idea'],
      questions: [{ id: 'problem', text: 'What problem are we trying to solve?' }],
      agentRoles: ['planner'],
      roles: ['facilitator'],
      approval: { beforePr: 'recommended' },
      scoring: { weights: { clarity: 1 } },
    });
    expect(methodology.defaultWorkflow).toBe('assist');
    expect(methodology.questions).toHaveLength(1);
    expect(methodology.approval).toEqual({ beforePr: 'recommended' });
    expect(methodology.scoring).toEqual({ weights: { clarity: 1 } });
  });

  it('rejects invalid approval values and agent roles', () => {
    expect(
      methodologySchema.safeParse({ ...minimalMethodology, approval: { plan: 'always' } }).success,
    ).toBe(false);
    expect(
      methodologySchema.safeParse({ ...minimalMethodology, agentRoles: ['wizard'] }).success,
    ).toBe(false);
  });
});
