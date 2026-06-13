import { describe, expect, it } from 'vitest';
import {
  CONTRIBUTION_KINDS,
  ContributionRegistry,
  DECLARATIVE_CONTRIBUTION_KINDS,
  PROGRAMMATIC_CONTRIBUTION_KINDS,
  type Contribution,
} from './contributions';

function workflowDefinition(name: string): Record<string, unknown> {
  return {
    id: 'fast-fix',
    name,
    mode: 'fast',
    phases: [{ id: 'work', name: 'Agent work', type: 'agent_work' }],
  };
}

function workflowContribution(
  name: string,
  source: Contribution['source'],
  extensionId: string,
): Contribution {
  return {
    kind: 'workflow',
    id: 'fast-fix',
    extensionId,
    source,
    definition: workflowDefinition(name),
  };
}

describe('contribution kind constants', () => {
  it('exposes 10 declarative + 10 programmatic = 20 kinds', () => {
    expect(DECLARATIVE_CONTRIBUTION_KINDS).toHaveLength(10);
    expect(PROGRAMMATIC_CONTRIBUTION_KINDS).toHaveLength(10);
    expect(CONTRIBUTION_KINDS).toHaveLength(20);
  });
});

describe('ContributionRegistry', () => {
  it('registers, gets and lists contributions by kind', () => {
    const registry = new ContributionRegistry();
    registry.register(workflowContribution('Fast fix', 'built_in', 'core-workflows'));
    registry.register({
      kind: 'question_pack',
      id: 'agent-readiness',
      extensionId: 'discovery-pack',
      source: 'built_in',
      definition: {
        id: 'agent-readiness',
        type: 'question_pack',
        name: 'Agent readiness',
        questions: [{ id: 'q1', text: 'Is the scope clear?' }],
      },
    });

    expect(registry.get('workflow', 'fast-fix')?.extensionId).toBe('core-workflows');
    expect(registry.get('workflow', 'missing')).toBeUndefined();
    expect(registry.list('workflow')).toHaveLength(1);
    expect(registry.list('question_pack')).toHaveLength(1);
    expect(registry.list()).toHaveLength(2);
    expect(registry.list('tool')).toEqual([]);
    expect(registry.warnings()).toEqual([]);
  });

  it('lets project contributions override built_in ones with the same id, silently', () => {
    const registry = new ContributionRegistry();
    registry.register(workflowContribution('Built-in fast fix', 'built_in', 'core-workflows'));
    registry.register(workflowContribution('Project fast fix', 'project', 'project'));

    const winner = registry.get('workflow', 'fast-fix');
    expect(winner?.source).toBe('project');
    expect(registry.list('workflow')).toHaveLength(1);
    expect(registry.workflows().map((w) => w.name)).toEqual(['Project fast fix']);
    // Overriding is the designed mechanism, not a conflict.
    expect(registry.warnings()).toEqual([]);
  });

  it('ignores a built_in registered after a project contribution, with a warning', () => {
    const registry = new ContributionRegistry();
    registry.register(workflowContribution('Project fast fix', 'project', 'project'));
    registry.register(workflowContribution('Built-in fast fix', 'built_in', 'core-workflows'));

    expect(registry.get('workflow', 'fast-fix')?.source).toBe('project');
    expect(registry.warnings()).toHaveLength(1);
    expect(registry.warnings()[0]).toContain("'workflow/fast-fix'");
    expect(registry.warnings()[0]).toContain('built_in');
  });

  it('ignores duplicate id+source registrations and records a warning', () => {
    const registry = new ContributionRegistry();
    registry.register(workflowContribution('First', 'project', 'project'));
    registry.register(workflowContribution('Second', 'project', 'other-ext'));

    expect(registry.list('workflow')).toHaveLength(1);
    expect(registry.workflows()[0]?.name).toBe('First');
    expect(registry.warnings()).toHaveLength(1);
    expect(registry.warnings()[0]).toContain('Duplicate contribution');
    expect(registry.warnings()[0]).toContain('other-ext');
  });

  it('lets local contributions override project ones (later sources win)', () => {
    const registry = new ContributionRegistry();
    registry.register(workflowContribution('Project', 'project', 'project'));
    registry.register(workflowContribution('Local', 'local', 'internal-tool'));
    expect(registry.get('workflow', 'fast-fix')?.source).toBe('local');
  });

  it('returns typed, normalized definitions from workflows() and methodologies()', () => {
    const registry = new ContributionRegistry();
    registry.register({
      kind: 'workflow',
      id: 'normalizing',
      extensionId: 'x',
      source: 'project',
      definition: {
        id: 'normalizing',
        name: 'Normalizing',
        mode: 'standard',
        phases: [{ id: 'plan', name: 'Plan', type: 'agent_output', optional: true }],
      },
    });
    registry.register({
      kind: 'methodology',
      id: 'lightweight',
      extensionId: 'x',
      source: 'project',
      definition: {
        id: 'lightweight',
        name: 'Lightweight',
        description: 'Minimal ceremony delivery.',
      },
    });

    const workflows = registry.workflows();
    expect(workflows).toHaveLength(1);
    // Validator normalizes `optional: true` → `required: false`.
    expect(workflows[0]?.phases[0]?.required).toBe(false);

    const methodologies = registry.methodologies();
    expect(methodologies).toHaveLength(1);
    expect(methodologies[0]?.id).toBe('lightweight');
  });

  it('rejects invalid declarative definitions with a recorded warning', () => {
    const registry = new ContributionRegistry();
    registry.register({
      kind: 'workflow',
      id: 'broken',
      extensionId: 'bad-ext',
      source: 'project',
      definition: { id: 'broken', name: 'Broken' }, // missing mode + phases
    });

    expect(registry.get('workflow', 'broken')).toBeUndefined();
    expect(registry.workflows()).toEqual([]);
    expect(registry.warnings()).toHaveLength(1);
    expect(registry.warnings()[0]).toContain('bad-ext');
    expect(registry.warnings()[0]).toContain('invalid definition');
  });

  it('stores programmatic contributions with their runtime value untouched', () => {
    const registry = new ContributionRegistry();
    const provider = { type: 'linear', getItem: () => null };
    registry.register({
      kind: 'work_item_provider',
      id: 'linear',
      extensionId: 'linear',
      source: 'local',
      value: provider,
    });
    expect(registry.get('work_item_provider', 'linear')?.value).toBe(provider);
  });

  it('exposes addWarning for loader-level warnings', () => {
    const registry = new ContributionRegistry();
    registry.addWarning('something odd');
    expect(registry.warnings()).toEqual(['something odd']);
  });
});
