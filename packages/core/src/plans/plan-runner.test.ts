import { describe, expect, it } from 'vitest';
import type { StructuredPlan } from './plan-model';
import { type PlanStepExecutor, runStructuredPlan } from './plan-runner';

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
