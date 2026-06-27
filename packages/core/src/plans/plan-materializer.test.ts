import { describe, expect, it } from 'vitest';
import type { StructuredPlan } from './plan-model';
import {
  materializePlanWorkItems,
  type MaterializeWorkItemInput,
  type PlanMaterializeOps,
} from './plan-materializer';

/** A two-phase plan: p1 {s1, s2}, p2 {s1 deps→p1.s2}. */
function makePlan(): StructuredPlan {
  return {
    version: 1,
    phases: [
      {
        id: 'p1',
        title: 'Setup',
        steps: [
          { id: 'p1.s1', title: 'Install', status: 'pending' },
          { id: 'p1.s2', title: 'Configure', status: 'pending', acceptance: 'config valid' },
        ],
      },
      {
        id: 'p2',
        title: 'Build',
        steps: [{ id: 'p2.s1', title: 'Compile', status: 'pending', deps: ['p1.s2'] }],
      },
    ],
  };
}

/** A fake work-item store: sequential keys, records every create + blockedBy edge. */
function fakeOps(): {
  ops: PlanMaterializeOps;
  created: Array<MaterializeWorkItemInput & { key: string }>;
  blocked: Record<string, string[]>;
} {
  const created: Array<MaterializeWorkItemInput & { key: string }> = [];
  const blocked: Record<string, string[]> = {};
  let n = 0;
  const ops: PlanMaterializeOps = {
    createWorkItem: (input) => {
      n += 1;
      const key = `WI-${n}`;
      created.push({ ...input, key });
      return { key };
    },
    setBlockedBy: (key, blockedBy) => {
      blocked[key] = blockedBy;
    },
  };
  return { ops, created, blocked };
}

describe('materializePlanWorkItems', () => {
  it('creates an epic + a sub-task per step, linking each step back', () => {
    const plan = makePlan();
    const { ops, created } = fakeOps();
    const result = materializePlanWorkItems(plan, ops, { task: 'Ship the thing' });

    // 1 epic + 3 steps.
    expect(result.created).toBe(4);
    expect(created).toHaveLength(4);
    // The epic is first, titled by the task, labelled plan/epic, no parent.
    expect(created[0]).toMatchObject({ title: 'Ship the thing', labels: ['plan', 'epic'] });
    expect(created[0]?.parentExternalId).toBeUndefined();
    expect(result.epicWorkItemId).toBe('WI-1');
    expect(plan.epicWorkItemId).toBe('WI-1');
    // Each step sub-task hangs off the epic and is linked back onto the plan.
    expect(created[1]).toMatchObject({ title: 'Install', parentExternalId: 'WI-1' });
    expect(created[2]).toMatchObject({ title: 'Configure', parentExternalId: 'WI-1' });
    expect(plan.phases[0]?.steps[0]?.workItemId).toBe('WI-2');
    expect(plan.phases[0]?.steps[1]?.workItemId).toBe('WI-3');
    expect(plan.phases[1]?.steps[0]?.workItemId).toBe('WI-4');
    // The step's acceptance becomes the sub-task description.
    expect(created[2]?.description).toBe('config valid');
  });

  it('translates step deps into work-item blockedBy edges', () => {
    const plan = makePlan();
    const { ops, blocked } = fakeOps();
    materializePlanWorkItems(plan, ops, { task: 'Ship' });
    // p2.s1 (WI-4) depends on p1.s2 (WI-3) → blockedBy [WI-3].
    expect(blocked['WI-4']).toEqual(['WI-3']);
    // Steps without deps get no edge.
    expect(blocked['WI-2']).toBeUndefined();
  });

  it('is idempotent: a fully-linked plan is a no-op (no duplicate work-items)', () => {
    const plan = makePlan();
    const { ops, created } = fakeOps();
    materializePlanWorkItems(plan, ops, { task: 'Ship' });
    expect(created).toHaveLength(4);

    // Re-run on the now-linked plan → nothing new created.
    const again = materializePlanWorkItems(plan, ops, { task: 'Ship' });
    expect(again.created).toBe(0);
    expect(created).toHaveLength(4);
    expect(again.epicWorkItemId).toBe('WI-1');
    expect(again.stepWorkItemIds['p2.s1']).toBe('WI-4');
  });

  it('is partial-safe: reuses the epic and only creates the unlinked steps', () => {
    const plan = makePlan();
    plan.epicWorkItemId = 'WI-99';
    plan.phases[0]!.steps[0]!.workItemId = 'WI-98'; // one step already linked
    const { ops, created } = fakeOps();
    const result = materializePlanWorkItems(plan, ops, { task: 'Ship' });

    // Epic reused (not recreated); only the 2 unlinked steps created.
    expect(result.epicWorkItemId).toBe('WI-99');
    expect(result.created).toBe(2);
    expect(created.every((c) => c.title !== 'Ship')).toBe(true); // no new epic
    expect(created.map((c) => c.title)).toEqual(['Configure', 'Compile']);
    expect(plan.phases[0]?.steps[0]?.workItemId).toBe('WI-98'); // untouched
  });

  it('handles an empty plan without creating anything', () => {
    const plan: StructuredPlan = { version: 1, phases: [] };
    const { ops, created } = fakeOps();
    const result = materializePlanWorkItems(plan, ops, { task: 'Nothing' });
    expect(result.created).toBe(0);
    expect(created).toHaveLength(0);
  });
});
