import { describe, expect, it } from 'vitest';
import { planAgentAllocation, type Subtask } from './agent-allocation';

describe('planAgentAllocation — pre-plan estimate (no decomposition)', () => {
  it('keeps focused task classes single-agent regardless of repo size', () => {
    for (const taskType of ['bugfix', 'docs'] as const) {
      const a = planAgentAllocation({ taskType, sensitive: false, affectedUnits: 12 });
      expect(a.agentCount).toBe(1);
      expect(a.parallelism).toBe('sequential');
      expect(a.decomposition).toEqual([]);
    }
  });

  it('does NOT fan out an ambiguous task (Discovery should clarify first)', () => {
    const a = planAgentAllocation({ taskType: 'ambiguous', sensitive: false, affectedUnits: 8 });
    expect(a.agentCount).toBe(1);
    expect(a.reason).toContain('ambiguous');
  });

  it('explores alternatives as a few parallel candidates', () => {
    const a = planAgentAllocation({ taskType: 'alternatives', sensitive: false });
    expect(a.agentCount).toBe(3);
    expect(a.parallelism).toBe('parallel');
    expect(a.reason).toContain('alternative');
  });

  it('scales a feature/refactor gently (~one agent per two modules)', () => {
    expect(
      planAgentAllocation({ taskType: 'feature', sensitive: false, affectedUnits: 1 }).agentCount,
    ).toBe(1);
    expect(
      planAgentAllocation({ taskType: 'feature', sensitive: false, affectedUnits: 6 }).agentCount,
    ).toBe(3);
    expect(
      planAgentAllocation({ taskType: 'refactor', sensitive: false, affectedUnits: 5 }).agentCount,
    ).toBe(3);
  });

  it('fans a migration out across modules (one per module)', () => {
    const a = planAgentAllocation({ taskType: 'migration', sensitive: false, affectedUnits: 4 });
    expect(a.agentCount).toBe(4);
    expect(a.parallelism).toBe('parallel');
  });

  it('defaults affectedUnits to 1 when omitted', () => {
    expect(planAgentAllocation({ taskType: 'feature', sensitive: false }).agentCount).toBe(1);
  });
});

describe('planAgentAllocation — post-plan precise (decomposition)', () => {
  const tasks: Subtask[] = [
    { id: 't1', title: 'API endpoint' },
    { id: 't2', title: 'DB schema' },
    { id: 't3', title: 'UI form' },
    { id: 't4', title: 'wire UI → API', dependsOn: ['t1', 't3'] }, // dependent → runs after
  ];

  it('assigns one agent per INDEPENDENT subtask; dependents run after', () => {
    const a = planAgentAllocation({ taskType: 'feature', sensitive: false, subtasks: tasks });
    expect(a.agentCount).toBe(3); // t1, t2, t3 independent; t4 depends on t1+t3
    expect(a.decomposition.map((s) => s.id)).toEqual(['t1', 't2', 't3']);
    expect(a.parallelism).toBe('parallel');
    expect(a.reason).toContain('3 independent subtask');
    expect(a.reason).toContain('+1 dependent');
  });

  it('a dangling dependency id does not count as a real dependency', () => {
    const a = planAgentAllocation({
      taskType: 'feature',
      sensitive: false,
      subtasks: [
        { id: 't1', title: 'one', dependsOn: ['ghost'] }, // ghost is not in the set
        { id: 't2', title: 'two' },
      ],
    });
    expect(a.agentCount).toBe(2);
  });

  it('a single subtask is one sequential agent', () => {
    const a = planAgentAllocation({
      taskType: 'feature',
      sensitive: false,
      subtasks: [{ id: 't1', title: 'only' }],
    });
    expect(a.agentCount).toBe(1);
    expect(a.parallelism).toBe('sequential');
  });

  it('decomposition wins over the affectedUnits estimate when both are given', () => {
    const a = planAgentAllocation({
      taskType: 'feature',
      sensitive: false,
      affectedUnits: 20, // would estimate 10 — but the plan is authoritative
      subtasks: tasks,
    });
    expect(a.agentCount).toBe(3);
  });
});

describe('planAgentAllocation — caps and biases', () => {
  it('reduces a large fan-out for sensitive areas (more review, less parallel)', () => {
    const a = planAgentAllocation({ taskType: 'migration', sensitive: true, affectedUnits: 8 });
    expect(a.agentCount).toBe(2);
    expect(a.capsApplied).toContain('sensitive');
    expect(a.reason).toContain('sensitive');
  });

  it('does not inflate a sensitive task that was already small', () => {
    const a = planAgentAllocation({ taskType: 'bugfix', sensitive: true, affectedUnits: 5 });
    expect(a.agentCount).toBe(1);
    expect(a.capsApplied).not.toContain('sensitive');
  });

  it('never exceeds the hard ceiling (maxAgents), and reports the cap', () => {
    const a = planAgentAllocation({
      taskType: 'migration',
      sensitive: false,
      affectedUnits: 10,
      maxAgents: 4,
    });
    expect(a.agentCount).toBe(4);
    expect(a.capsApplied).toContain('maxAgents');
    expect(a.reason).toContain('capped at 4');
  });

  it('trims the decomposition to the capped count (only that many get an agent)', () => {
    const subtasks: Subtask[] = [
      { id: 't1', title: 'a' },
      { id: 't2', title: 'b' },
      { id: 't3', title: 'c' },
    ];
    const a = planAgentAllocation({
      taskType: 'feature',
      sensitive: false,
      subtasks,
      maxAgents: 2,
    });
    expect(a.agentCount).toBe(2);
    expect(a.decomposition.map((s) => s.id)).toEqual(['t1', 't2']);
  });

  it('honors a power-user requested count, still clamped by maxAgents', () => {
    const free = planAgentAllocation({ taskType: 'bugfix', sensitive: false, requested: 5 });
    expect(free.agentCount).toBe(5);
    expect(free.capsApplied).toContain('requested');
    expect(free.reason).toContain('you requested 5');

    const capped = planAgentAllocation({
      taskType: 'bugfix',
      sensitive: false,
      requested: 5,
      maxAgents: 3,
    });
    expect(capped.agentCount).toBe(3);
    expect(capped.capsApplied).toEqual(['requested', 'maxAgents']);
  });

  it('always allocates at least one agent', () => {
    expect(
      planAgentAllocation({ taskType: 'feature', sensitive: false, requested: 0 }).agentCount,
    ).toBe(1);
    expect(
      planAgentAllocation({ taskType: 'feature', sensitive: false, maxAgents: 0 }).agentCount,
    ).toBe(1);
    expect(
      planAgentAllocation({ taskType: 'feature', sensitive: false, subtasks: [] }).agentCount,
    ).toBe(1);
  });

  it('is deterministic — identical input yields identical output', () => {
    const input = {
      taskType: 'migration' as const,
      sensitive: false,
      affectedUnits: 6,
      maxAgents: 4,
    };
    expect(planAgentAllocation(input)).toEqual(planAgentAllocation(input));
  });
});
