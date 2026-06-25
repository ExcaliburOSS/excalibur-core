import { describe, expect, it } from 'vitest';
import type { StructuredChatRunner } from '../structured/structured-output';
import { topologicalWaves } from '../swarm/toposort';
import { coerceMission, fallbackMission, interpretMission } from './interpret-mission';
import { fallbackPlan, normalizePlan, planStrategy } from './plan-strategy';
import type { Mission, PlanStep } from './types';

/** A gateway that returns a fixed JSON string (askStructured extracts + validates it). */
function fakeGateway(content: string): StructuredChatRunner {
  return { chat: () => Promise.resolve({ content }) };
}
/** A gateway that always throws (model unavailable). */
const brokenGateway: StructuredChatRunner = {
  chat: () => Promise.reject(new Error('model down')),
};

const mission = (over: Partial<Mission> = {}): Mission => ({
  goal: 'Add rate limiting to the API',
  interpretation: 'Protect the API from abuse with a token-bucket limiter',
  complexity: 'medium',
  risk: 'medium',
  successCriteria: ['requests over the limit get 429', 'tests pass'],
  needsClarification: false,
  needsUnderstanding: true,
  parallelizable: false,
  ...over,
});

describe('interpretMission', () => {
  it('parses a well-formed Mission from the model', async () => {
    const json = JSON.stringify({
      interpretation: 'Add a token-bucket limiter to protect the API',
      complexity: 'large',
      risk: 'high',
      successCriteria: ['429 over the limit', 'no regression'],
      needsClarification: false,
      needsUnderstanding: true,
      parallelizable: true,
    });
    const m = await interpretMission('add rate limiting', { gateway: fakeGateway(json) });
    expect(m.goal).toBe('add rate limiting');
    expect(m.complexity).toBe('large');
    expect(m.risk).toBe('high');
    expect(m.successCriteria).toHaveLength(2);
    expect(m.parallelizable).toBe(true);
    expect(m.needsUnderstanding).toBe(true);
  });

  it('falls back safely when the model is unavailable', async () => {
    const m = await interpretMission('do something', { gateway: brokenGateway });
    expect(m).toEqual(fallbackMission('do something'));
    expect(m.needsUnderstanding).toBe(true); // conservative default
  });

  it('returns the fallback for an empty goal without calling the model', async () => {
    const m = await interpretMission('   ', { gateway: brokenGateway });
    expect(m.goal).toBe('   ');
    expect(m.complexity).toBe('medium');
  });

  it('coerces garbage fields to safe defaults', () => {
    const m = coerceMission(
      { complexity: 'galactic', risk: 42, successCriteria: 'nope', needsUnderstanding: false },
      'g',
    );
    expect(m.complexity).toBe('medium'); // invalid enum → default
    expect(m.risk).toBe('medium');
    expect(m.successCriteria.length).toBeGreaterThan(0); // non-array → default
    expect(m.needsUnderstanding).toBe(false); // explicit false honored
  });
});

describe('planStrategy', () => {
  it('composes a valid, acyclic capability DAG from the model', async () => {
    const json = JSON.stringify({
      rationale: 'Understand, implement, test, then verify the risky change.',
      steps: [
        { id: 'u', capability: 'understand', objective: 'map the api', dependsOn: [], gate: false },
        {
          id: 'i',
          capability: 'implement',
          objective: 'add limiter',
          dependsOn: ['u'],
          gate: false,
        },
        { id: 't', capability: 'test', objective: 'run tests', dependsOn: ['i'], gate: true },
      ],
    });
    const plan = await planStrategy(mission(), { gateway: fakeGateway(json) });
    expect(plan.steps.map((s) => s.capability)).toEqual(['understand', 'implement', 'test']);
    expect(topologicalWaves(plan.steps)).not.toBeNull(); // acyclic
    expect(plan.rationale).toContain('verify');
  });

  it('ENFORCES understand-first when the mission needs it but the model omitted it', async () => {
    const json = JSON.stringify({
      rationale: 'just implement',
      steps: [{ id: 'i', capability: 'implement', objective: 'do it', dependsOn: [], gate: false }],
    });
    const plan = await planStrategy(mission({ needsUnderstanding: true }), {
      gateway: fakeGateway(json),
    });
    expect(plan.steps[0]?.capability).toBe('understand');
    // the implement step now roots on understanding.
    const impl = plan.steps.find((s) => s.capability === 'implement');
    expect(impl?.dependsOn).toContain('understand');
  });

  it('ENFORCES a clarify (discover) step first when the mission is ambiguous', async () => {
    const json = JSON.stringify({
      rationale: 'x',
      steps: [{ id: 'i', capability: 'implement', objective: 'do it', dependsOn: [], gate: false }],
    });
    const plan = await planStrategy(
      mission({ needsClarification: true, needsUnderstanding: false }),
      {
        gateway: fakeGateway(json),
      },
    );
    expect(plan.steps[0]?.capability).toBe('discover');
  });

  it('adds a work step when the model produced none', () => {
    const steps = normalizePlan(
      [{ id: 'r', capability: 'review', objective: 'review', dependsOn: [], gate: false }],
      mission({ needsUnderstanding: false }),
    );
    expect(steps.some((s) => s.capability === 'implement')).toBe(true);
  });

  it('degrades a cyclic plan to a stable linear chain', () => {
    const cyclic: PlanStep[] = [
      { id: 'a', capability: 'implement', objective: 'a', dependsOn: ['b'], gate: false },
      { id: 'b', capability: 'test', objective: 'b', dependsOn: ['a'], gate: false },
    ];
    const steps = normalizePlan(cyclic, mission({ needsUnderstanding: false }));
    expect(topologicalWaves(steps)).not.toBeNull(); // cycle broken → orderable
    expect(steps[0]?.dependsOn).toEqual([]);
  });

  it('falls back to a sound default plan when the model is unavailable', async () => {
    const plan = await planStrategy(mission({ risk: 'high' }), { gateway: brokenGateway });
    const kinds = plan.steps.map((s) => s.capability);
    expect(kinds).toContain('understand');
    expect(kinds).toContain('implement');
    expect(kinds).toContain('test');
    expect(kinds).toContain('verify'); // high risk → verify gate
    expect(plan.steps.find((s) => s.capability === 'verify')?.gate).toBe(true);
  });

  it('fallbackPlan stays acyclic for every risk level', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      const plan = fallbackPlan(mission({ risk }));
      expect(topologicalWaves(plan.steps)).not.toBeNull();
    }
  });
});
