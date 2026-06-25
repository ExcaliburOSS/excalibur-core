import { describe, expect, it } from 'vitest';
import type { StructuredChatRunner } from '../structured/structured-output';
import { coerceDecision, createReassessor } from './reassess';
import {
  defaultReassess,
  runMission,
  type CapabilityExecutor,
  type Reassessor,
  type StepResult,
} from './supervisor';
import type { Mission, OrchestrationPlan, PlanStep } from './types';

const mission = (): Mission => ({
  goal: 'do the thing',
  interpretation: 'do the thing',
  complexity: 'medium',
  risk: 'medium',
  successCriteria: ['it works'],
  needsClarification: false,
  needsUnderstanding: false,
  parallelizable: false,
});

const step = (
  id: string,
  capability: PlanStep['capability'],
  dependsOn: string[] = [],
  gate = false,
): PlanStep => ({ id, capability, objective: id, dependsOn, gate });

const plan = (steps: PlanStep[]): OrchestrationPlan => ({ goal: 'g', steps, rationale: 'r' });

/** An executor whose result is scripted per step id (default: ok). */
function scriptedExecutor(
  script: Record<string, (attempt: number) => StepResult>,
  order: string[] = [],
): CapabilityExecutor {
  const attempts: Record<string, number> = {};
  return (s) => {
    order.push(s.id);
    const n = (attempts[s.id] = (attempts[s.id] ?? 0) + 1);
    const fn = script[s.id];
    return Promise.resolve(fn ? fn(n) : { ok: true, summary: `${s.id} ok` });
  };
}

const ok = (): StepResult => ({ ok: true, summary: 'ok' });
const fail = (): StepResult => ({ ok: false, summary: 'boom' });

describe('runMission (supervisor)', () => {
  it('drives steps in dependency order and completes a clean plan', async () => {
    const order: string[] = [];
    const state = await runMission(
      mission(),
      plan([step('c', 'test', ['b']), step('a', 'understand'), step('b', 'implement', ['a'])]),
      { executor: scriptedExecutor({}, order) },
    );
    expect(order).toEqual(['a', 'b', 'c']); // topological, not array order
    expect(state.outcome).toBe('completed');
    expect(state.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('treats a thrown executor as a failed step', async () => {
    const executor: CapabilityExecutor = () => Promise.reject(new Error('kaboom'));
    const state = await runMission(mission(), plan([step('i', 'implement')]), { executor });
    expect(state.steps[0]?.status).toBe('failed');
    expect(state.steps[0]?.result?.summary).toContain('kaboom');
  });

  it('aborts on a GATE failure under the default policy', async () => {
    const state = await runMission(
      mission(),
      plan([
        step('i', 'implement'),
        step('t', 'test', ['i'], true), // gate
        step('s', 'ship', ['t']),
      ]),
      { executor: scriptedExecutor({ t: fail }) },
    );
    expect(state.outcome).toBe('aborted');
    // ship never ran (its gate dep failed → mission aborted).
    expect(state.steps.find((s) => s.step.id === 's')?.status).toBe('pending');
  });

  it('skips dependents of a non-gate failure and continues', async () => {
    const state = await runMission(
      mission(),
      plan([
        step('u', 'understand'),
        step('i', 'implement', ['u']), // non-gate work step that fails
        step('r', 'review', ['i']),
      ]),
      { executor: scriptedExecutor({ i: fail }) },
    );
    expect(state.steps.find((s) => s.step.id === 'r')?.status).toBe('skipped');
    expect(state.outcome).toBe('failed'); // a WORK step failed
  });

  it('retries a failed step when the reassessor says so (bounded)', async () => {
    // Fails the first attempt, succeeds the second.
    const executor = scriptedExecutor({ i: (n) => (n < 2 ? fail() : ok()) });
    const reassess: Reassessor = (_s, last) =>
      Promise.resolve(
        last.result?.ok
          ? { action: 'continue', reason: 'ok' }
          : { action: 'retry', reason: 'transient' },
      );
    const state = await runMission(mission(), plan([step('i', 'implement', [], true)]), {
      executor,
      reassess,
    });
    expect(state.steps[0]?.status).toBe('done');
    expect(state.steps[0]?.attempts).toBe(2);
    expect(state.outcome).toBe('completed');
  });

  it('escalates a struggling step to a stronger capability', async () => {
    // implement fails; escalate to parallelize, which succeeds.
    const executor = scriptedExecutor({ i: (n) => (n < 2 ? fail() : ok()) });
    const reassess: Reassessor = (_s, last) =>
      Promise.resolve(
        last.result?.ok
          ? { action: 'continue', reason: 'ok' }
          : { action: 'escalate', reason: 'needs parallelism', escalateTo: 'parallelize' },
      );
    const state = await runMission(mission(), plan([step('i', 'implement', [], true)]), {
      executor,
      reassess,
    });
    expect(state.steps[0]?.step.capability).toBe('parallelize'); // swapped
    expect(state.steps[0]?.status).toBe('done');
  });

  it('replans by splicing new steps the model discovered were needed', async () => {
    const order: string[] = [];
    let replanned = false;
    const reassess: Reassessor = (_s, last) => {
      if (last.step.id === 'i' && !replanned) {
        replanned = true;
        return Promise.resolve({
          action: 'replan',
          reason: 'needs a migration first',
          addSteps: [step('m', 'implement', ['i'])],
        });
      }
      return Promise.resolve({ action: 'continue', reason: 'ok' });
    };
    const state = await runMission(mission(), plan([step('i', 'implement', [], true)]), {
      executor: scriptedExecutor({}, order),
      reassess,
    });
    expect(order).toContain('m'); // the spliced step ran
    expect(state.steps.some((s) => s.step.id === 'm')).toBe(true);
  });

  it('a replan SUPERSEDES the failed gate that triggered it (outcome not doomed)', async () => {
    // The gate fails; the model replans with a corrective step instead of aborting.
    const order: string[] = [];
    let replanned = false;
    const reassess: Reassessor = (_s, last) => {
      if (last.step.id === 't' && !replanned) {
        replanned = true;
        return Promise.resolve({
          action: 'replan',
          reason: 'fix the bug, then re-test',
          addSteps: [step('fix', 'implement', []), step('retest', 'test', ['fix'])],
        });
      }
      return Promise.resolve({ action: 'continue', reason: 'ok' });
    };
    const state = await runMission(
      mission(),
      plan([
        step('i', 'implement'),
        step('t', 'test', ['i'], true), // failing gate
      ]),
      { executor: scriptedExecutor({ t: fail }, order), reassess },
    );
    // The corrective steps ran; the superseded gate is skipped, not a dooming failure.
    expect(order).toContain('fix');
    expect(order).toContain('retest');
    expect(state.steps.find((s) => s.step.id === 't')?.status).toBe('skipped');
    expect(state.outcome).toBe('completed');
  });

  it('ends early when the reassessor declares the criteria met (done)', async () => {
    const reassess: Reassessor = () => Promise.resolve({ action: 'done', reason: 'criteria met' });
    const state = await runMission(
      mission(),
      plan([step('i', 'implement', [], true), step('t', 'test', ['i'])]),
      { executor: scriptedExecutor({}), reassess },
    );
    expect(state.done).toBe(true);
    expect(state.steps.find((s) => s.step.id === 't')?.status).toBe('pending'); // never reached
  });

  it('aborts immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const state = await runMission(mission(), plan([step('i', 'implement')]), {
      executor: scriptedExecutor({}),
      signal: ctrl.signal,
    });
    expect(state.outcome).toBe('aborted');
  });

  it('emits a progress event stream consumable by the TUI / dashboard', async () => {
    const events: string[] = [];
    await runMission(mission(), plan([step('i', 'implement')]), {
      executor: scriptedExecutor({}),
      onEvent: (e) => events.push(e.kind),
    });
    expect(events).toContain('step_started');
    expect(events).toContain('step_done');
    expect(events).toContain('mission_done');
  });
});

describe('reassess decision parsing', () => {
  const last = {
    step: step('i', 'implement', [], true),
    status: 'failed' as const,
    attempts: 1,
    result: fail(),
  };

  it('coerces a valid model decision', () => {
    const d = coerceDecision(
      { action: 'escalate', reason: 'go wide', escalateTo: 'explore' },
      last,
    );
    expect(d.action).toBe('escalate');
    expect(d.escalateTo).toBe('explore');
  });

  it('falls back to the deterministic policy on garbage', () => {
    const d = coerceDecision({ action: 'teleport' }, last);
    expect(d).toEqual(defaultReassess(last)); // gate failure → abort
  });

  it('createReassessor returns a model decision (structured)', async () => {
    const gateway: StructuredChatRunner = {
      chat: () =>
        Promise.resolve({ content: JSON.stringify({ action: 'retry', reason: 'flaky' }) }),
    };
    const reassess = createReassessor({ gateway });
    const d = await reassess(
      { mission: mission(), steps: [], log: [], done: false, outcome: 'pending' },
      last,
    );
    expect(d.action).toBe('retry');
  });
});
