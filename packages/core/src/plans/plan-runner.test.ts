import { describe, expect, it } from 'vitest';
import type { PlanStep, StructuredPlan } from './plan-model';
import {
  type PlanPhaseExecutor,
  type PlanStepExecutor,
  type PlanStepResult,
  runStructuredPlan,
} from './plan-runner';

/** A two-phase plan: p1 {s1, s2}, p2 {s1}. All pending unless overridden. */
function makePlan(
  overrides: Record<string, Partial<StructuredPlan['phases'][number]['steps'][number]>> = {},
): StructuredPlan {
  const step = (id: string, title: string) => ({
    id,
    title,
    status: 'pending' as const,
    ...overrides[id],
  });
  return {
    version: 1,
    phases: [
      { id: 'p1', title: 'Phase one', steps: [step('p1.s1', 'First'), step('p1.s2', 'Second')] },
      { id: 'p2', title: 'Phase two', steps: [step('p2.s1', 'Third')] },
    ],
  };
}

/** An executor that records the order it ran steps, and marks each `done`. */
function recordingExecutor(): { executor: PlanStepExecutor; ran: string[] } {
  const ran: string[] = [];
  const executor: PlanStepExecutor = async (step) => {
    ran.push(step.id);
    return { status: 'done', runId: `run_${step.id}` };
  };
  return { executor, ran };
}

describe('runStructuredPlan', () => {
  it('runs every step in phase/step order and completes', async () => {
    const plan = makePlan();
    const { executor, ran } = recordingExecutor();
    const result = await runStructuredPlan(plan, executor);

    expect(ran).toEqual(['p1.s1', 'p1.s2', 'p2.s1']);
    expect(result.completed).toBe(true);
    expect(result.ranSteps).toBe(3);
    expect(result.stoppedAtStepId).toBeNull();
    expect(result.blockedStepIds).toEqual([]);
    // Each step is now done and carries its run id.
    expect(plan.phases[0]?.steps[0]?.status).toBe('done');
    expect(plan.phases[0]?.steps[0]?.runId).toBe('run_p1.s1');
    expect(plan.phases[1]?.steps[0]?.status).toBe('done');
  });

  it('RESUMES: skips already-done/skipped steps and runs only the rest', async () => {
    const plan = makePlan({
      'p1.s1': { status: 'done' },
      'p1.s2': { status: 'skipped' },
    });
    const { executor, ran } = recordingExecutor();
    const result = await runStructuredPlan(plan, executor);

    // Only the one unfinished step ran.
    expect(ran).toEqual(['p2.s1']);
    expect(result.ranSteps).toBe(1);
    expect(result.completed).toBe(true);
  });

  it('emits onStep for active then the terminal status of each step', async () => {
    const plan = makePlan();
    const { executor } = recordingExecutor();
    const seen: Array<{ id: string; status: string }> = [];
    const result = await runStructuredPlan(plan, executor, {
      onStep: (step) => seen.push({ id: step.id, status: step.status }),
    });

    expect(result.completed).toBe(true);
    // First step: active, then done — and so on.
    expect(seen.slice(0, 2)).toEqual([
      { id: 'p1.s1', status: 'active' },
      { id: 'p1.s1', status: 'done' },
    ]);
    expect(seen.filter((s) => s.status === 'active').map((s) => s.id)).toEqual([
      'p1.s1',
      'p1.s2',
      'p2.s1',
    ]);
  });

  it('blocks a step whose dependency is not done, and stops there by default', async () => {
    const plan = makePlan({ 'p2.s1': { deps: ['p1.s2'] } });
    // An executor that does NOT finish p1.s2 (leaves it blocked), so p2.s1 dep is unmet.
    const ran: string[] = [];
    const executor: PlanStepExecutor = async (step) => {
      ran.push(step.id);
      if (step.id === 'p1.s2') return { status: 'blocked' };
      return { status: 'done' };
    };
    const result = await runStructuredPlan(plan, executor);

    // p1.s1 ran (done), p1.s2 ran (blocked) → stop, p2.s1 never attempted.
    expect(ran).toEqual(['p1.s1', 'p1.s2']);
    expect(result.completed).toBe(false);
    expect(result.blockedStepIds).toEqual(['p1.s2']);
    expect(result.stoppedAtStepId).toBe('p1.s2');
  });

  it('gates a dependent step as blocked when its dep is unmet (continueOnBlock)', async () => {
    // p2.s1 depends on p1.s2; force p1.s2 to block, but keep going.
    const plan = makePlan({ 'p2.s1': { deps: ['p1.s2'] } });
    const executor: PlanStepExecutor = async (step) =>
      step.id === 'p1.s2' ? { status: 'blocked' } : { status: 'done' };
    const result = await runStructuredPlan(plan, executor, { continueOnBlock: true });

    // p1.s2 blocked (executor), p2.s1 blocked (unmet dep) — both recorded.
    expect(result.completed).toBe(false);
    expect(result.blockedStepIds).toEqual(['p1.s2', 'p2.s1']);
    expect(plan.phases[1]?.steps[0]?.status).toBe('blocked');
  });

  it('marks a step blocked when the executor throws (never propagates)', async () => {
    const plan = makePlan();
    const executor: PlanStepExecutor = async (step) => {
      if (step.id === 'p1.s2') throw new Error('boom');
      return { status: 'done' };
    };
    const result = await runStructuredPlan(plan, executor);

    expect(result.blockedStepIds).toEqual(['p1.s2']);
    expect(plan.phases[0]?.steps[1]?.status).toBe('blocked');
    expect(result.completed).toBe(false);
    expect(result.stoppedAtStepId).toBe('p1.s2');
  });

  it('stops cleanly when the signal is aborted mid-run', async () => {
    const plan = makePlan();
    const controller = new AbortController();
    const ran: string[] = [];
    const executor: PlanStepExecutor = async (step) => {
      ran.push(step.id);
      if (step.id === 'p1.s1') controller.abort(); // abort after the first step
      return { status: 'done' };
    };
    const result = await runStructuredPlan(plan, executor, { signal: controller.signal });

    expect(ran).toEqual(['p1.s1']);
    expect(result.completed).toBe(false);
    expect(result.stoppedAtStepId).toBe('p1.s2');
  });

  it('reports stoppedAtStepId as the first pending step when not completed', async () => {
    const plan = makePlan();
    // Run nothing — abort before the first step.
    const controller = new AbortController();
    controller.abort();
    const { executor, ran } = recordingExecutor();
    const result = await runStructuredPlan(plan, executor, { signal: controller.signal });

    expect(ran).toEqual([]);
    expect(result.ranSteps).toBe(0);
    expect(result.stoppedAtStepId).toBe('p1.s1');
  });
});

/** A phase executor that records each BATCH it received and returns a verdict map
 * (all `done` unless `verdict` overrides a step). Mirrors the swarm fan-out. */
function recordingPhaseExecutor(verdict: Record<string, PlanStepResult> = {}): {
  phaseExecutor: PlanPhaseExecutor;
  batches: string[][];
} {
  const batches: string[][] = [];
  const phaseExecutor: PlanPhaseExecutor = async (steps: PlanStep[]) => {
    batches.push(steps.map((s) => s.id));
    return new Map(
      steps.map((s) => [s.id, verdict[s.id] ?? { status: 'done', runId: `run_${s.id}` }]),
    );
  };
  return { phaseExecutor, batches };
}

describe('runStructuredPlan — G1 parallel phase fan-out', () => {
  it('fans a phase of ≥2 independent steps out through the phaseExecutor, not step-by-step', async () => {
    const plan = makePlan(); // p1 {s1, s2} independent, p2 {s1}
    const { executor, ran } = recordingExecutor();
    const { phaseExecutor, batches } = recordingPhaseExecutor();
    const seen: Array<{ id: string; status: string }> = [];

    const result = await runStructuredPlan(plan, executor, {
      phaseExecutor,
      onStep: (step) => seen.push({ id: step.id, status: step.status }),
    });

    // p1's two independent steps ran as ONE batch through the swarm executor…
    expect(batches).toEqual([['p1.s1', 'p1.s2']]);
    // …and the single-step p2 fell through to the per-step (sequential) executor.
    expect(ran).toEqual(['p2.s1']);
    expect(result.completed).toBe(true);
    expect(result.ranSteps).toBe(3);
    // The fanned-out steps still emit active→done and carry their run id (checkpoint).
    expect(seen.filter((s) => s.id === 'p1.s1')).toEqual([
      { id: 'p1.s1', status: 'active' },
      { id: 'p1.s1', status: 'done' },
    ]);
    expect(plan.phases[0]?.steps[0]?.runId).toBe('run_p1.s1');
    expect(plan.phases[0]?.steps[1]?.status).toBe('done');
  });

  it('does NOT fan out a phase with an intra-phase dependency (runs it sequentially)', async () => {
    // p1.s2 depends on p1.s1 → the not-done set is not mutually independent.
    const plan = makePlan({ 'p1.s2': { deps: ['p1.s1'] } });
    const { executor, ran } = recordingExecutor();
    const { phaseExecutor, batches } = recordingPhaseExecutor();

    const result = await runStructuredPlan(plan, executor, { phaseExecutor });

    expect(batches).toEqual([]); // never fanned out
    expect(ran).toEqual(['p1.s1', 'p1.s2', 'p2.s1']); // strict sequential order
    expect(result.completed).toBe(true);
  });

  it('does NOT fan out a phase down to a single remaining step (resume case)', async () => {
    // p1.s1 already done → only p1.s2 remains in p1 (a batch of one never fans out).
    const plan = makePlan({ 'p1.s1': { status: 'done' } });
    const { executor, ran } = recordingExecutor();
    const { phaseExecutor, batches } = recordingPhaseExecutor();

    const result = await runStructuredPlan(plan, executor, { phaseExecutor });

    expect(batches).toEqual([]);
    expect(ran).toEqual(['p1.s2', 'p2.s1']);
    expect(result.completed).toBe(true);
  });

  it('applies per-step verdicts from the batch and stops on a blocked lane (resumable)', async () => {
    const plan = makePlan(); // p1 {s1, s2}
    const { executor, ran } = recordingExecutor();
    // The swarm merged one lane but the other lane blocked (unlanded/failed).
    const { phaseExecutor, batches } = recordingPhaseExecutor({
      'p1.s2': { status: 'blocked' },
    });

    const result = await runStructuredPlan(plan, executor, { phaseExecutor });

    expect(batches).toEqual([['p1.s1', 'p1.s2']]);
    expect(result.completed).toBe(false);
    expect(result.blockedStepIds).toEqual(['p1.s2']);
    expect(plan.phases[0]?.steps[0]?.status).toBe('done');
    expect(plan.phases[0]?.steps[1]?.status).toBe('blocked');
    // The plan stopped at the blocked phase — the next phase never ran.
    expect(ran).toEqual([]);
    expect(result.stoppedAtStepId).toBe('p1.s2');
  });

  it('treats a batch that throws as all-blocked (never propagates)', async () => {
    const plan = makePlan();
    const { executor } = recordingExecutor();
    const phaseExecutor: PlanPhaseExecutor = async () => {
      throw new Error('swarm exploded');
    };

    const result = await runStructuredPlan(plan, executor, { phaseExecutor });

    expect(result.completed).toBe(false);
    expect(result.blockedStepIds).toEqual(['p1.s1', 'p1.s2']);
    expect(plan.phases[0]?.steps[0]?.status).toBe('blocked');
  });

  it('runs phases in order — a later phase fans out only after earlier phases finish', async () => {
    // Two phases, each with two independent steps.
    const plan: StructuredPlan = {
      version: 1,
      phases: [
        {
          id: 'p1',
          title: 'One',
          steps: [
            { id: 'p1.s1', title: 'a', status: 'pending' },
            { id: 'p1.s2', title: 'b', status: 'pending' },
          ],
        },
        {
          id: 'p2',
          title: 'Two',
          steps: [
            { id: 'p2.s1', title: 'c', status: 'pending' },
            { id: 'p2.s2', title: 'd', status: 'pending' },
          ],
        },
      ],
    };
    const { executor } = recordingExecutor();
    const { phaseExecutor, batches } = recordingPhaseExecutor();

    const result = await runStructuredPlan(plan, executor, { phaseExecutor });

    // Each phase became its own batch, in phase order (the gate between them).
    expect(batches).toEqual([
      ['p1.s1', 'p1.s2'],
      ['p2.s1', 'p2.s2'],
    ]);
    expect(result.completed).toBe(true);
  });
});
