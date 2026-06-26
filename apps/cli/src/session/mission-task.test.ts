import { describe, expect, it } from 'vitest';
import type { Mission, PlanStep } from '@excalibur/core';
import { capabilityTask } from './mission-run';

const mission: Mission = {
  goal: 'add rate limiting to the API',
  interpretation: 'add rate limiting',
  complexity: 'medium',
  risk: 'low',
  successCriteria: ['requests are throttled'],
  needsClarification: false,
  needsUnderstanding: true,
  parallelizable: false,
};

const step = (capability: string, objective = 'do the thing'): PlanStep => ({
  id: `s-${capability}`,
  capability: capability as PlanStep['capability'],
  objective,
  dependsOn: [],
  gate: false,
});

describe('capabilityTask — understanding feed-forward (AO9 → mission)', () => {
  it('carries the framing, objective and overall goal', () => {
    const t = capabilityTask(step('implement'), mission);
    expect(t).toContain('add rate limiting to the API'); // overall goal
    expect(t).toContain('do the thing'); // objective
    expect(t).toContain('Implement the objective'); // the capability framing
  });

  it('threads the scope map into a LATER step so it builds on the understanding', () => {
    const understanding = '## Rate limiter\nExists: nothing. Missing: the whole limiter.';
    const t = capabilityTask(step('implement'), mission, { understanding });
    expect(t).toContain('an earlier read-only scope already established');
    expect(t).toContain('build ON it');
    expect(t).toContain('the whole limiter'); // the scope content is present
  });

  it('does NOT feed the understanding back into the understand step itself', () => {
    const understanding = 'previous scope map';
    const t = capabilityTask(step('understand'), mission, { understanding });
    expect(t).not.toContain('previous scope map');
    expect(t).not.toContain('build ON it');
  });

  it('omits the scope preamble when there is no understanding yet', () => {
    const t = capabilityTask(step('plan'), mission, { understanding: '' });
    expect(t).not.toContain('an earlier read-only scope');
  });

  it('caps the injected understanding so a huge map cannot blow the prompt', () => {
    const huge = 'x'.repeat(10_000);
    const t = capabilityTask(step('implement'), mission, { understanding: huge });
    // base prompt + preamble + at most 4000 chars of the map.
    expect(t.length).toBeLessThan(4500);
    expect(t).toContain('an earlier read-only scope');
  });
});
