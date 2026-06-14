import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, type ExcaliburEvent } from '@excalibur/shared';
import { makeTempDir, removeDir } from '../test-utils';
import { RunManager } from '../runs/run-manager';
import {
  addAnnotation,
  annotationsForStep,
  loadAnnotations,
  loadReplay,
  nextStepOfKind,
  phaseBoundaries,
  prevStepOfKind,
  reconstructStateAt,
} from './replay';

/**
 * Deterministic, offline tests for the time-machine model. A known event
 * sequence is written through RunManager (the real on-disk contract) and the
 * replay model is asserted end-to-end: steps, cumulative cost/tokens, summaries,
 * cursor reconstruction (phase + accumulated diff + cost), semantic jumps and
 * annotation round-tripping.
 */

const PHASE_IMPL = 'phase_impl';
const PHASE_VERIFY = 'phase_verify';
const SAMPLE_DIFF = [
  '--- /dev/null',
  '+++ b/src/release.ts',
  '@@ -0,0 +1,2 @@',
  '+export const released = true;',
  '+// idempotency guard',
].join('\n');

describe('replay time-machine model', () => {
  let repoRoot: string;
  let manager: RunManager;
  let runId: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
    manager = new RunManager(repoRoot);
    const run = manager.createRun({
      title: 'Fix duplicated release',
      autonomyLevel: 4,
      workflow: 'structured-feature',
      methodology: null,
      model: 'mock-model',
      executionStyle: 'structured',
    });
    runId = run.id;

    const events: ExcaliburEvent[] = [
      createEvent({ runId, type: 'run_started', payload: { title: 'Fix duplicated release' } }),
      createEvent({
        runId,
        type: 'phase_started',
        payload: { name: 'Implement', type: 'agent_work' },
        phaseId: PHASE_IMPL,
      }),
      createEvent({
        runId,
        type: 'model_call',
        payload: { model: 'mock-model', kind: 'patch', inputTokens: 1200, outputTokens: 340, costCents: 5 },
        phaseId: PHASE_IMPL,
      }),
      createEvent({
        runId,
        type: 'file_write',
        payload: { path: 'src/release.ts', diff: SAMPLE_DIFF },
        phaseId: PHASE_IMPL,
      }),
      createEvent({
        runId,
        type: 'phase_completed',
        payload: { name: 'Implement', status: 'completed' },
        phaseId: PHASE_IMPL,
      }),
      createEvent({
        runId,
        type: 'phase_started',
        payload: { name: 'Verify', type: 'command_group' },
        phaseId: PHASE_VERIFY,
      }),
      createEvent({
        runId,
        type: 'command_completed',
        payload: { command: 'npm test', exitCode: 0 },
        phaseId: PHASE_VERIFY,
      }),
      createEvent({
        runId,
        type: 'test_result',
        payload: { status: 'failed', commands: ['npm test'] },
        phaseId: PHASE_VERIFY,
      }),
      createEvent({
        runId,
        type: 'model_call',
        payload: { model: 'mock-model', kind: 'patch', inputTokens: 800, outputTokens: 120, costCents: 3 },
        phaseId: PHASE_VERIFY,
      }),
      createEvent({
        runId,
        type: 'patch_generated',
        payload: { diff: SAMPLE_DIFF, filesAffected: ['src/release.ts'], artifact: 'diff.patch' },
        phaseId: PHASE_VERIFY,
      }),
      createEvent({
        runId,
        type: 'approval_requested',
        payload: { question: 'Apply the generated patch?' },
        phaseId: PHASE_VERIFY,
      }),
      createEvent({
        runId,
        type: 'phase_completed',
        payload: { name: 'Verify', status: 'completed' },
        phaseId: PHASE_VERIFY,
      }),
      createEvent({ runId, type: 'run_completed', payload: { status: 'completed' } }),
    ];
    for (const event of events) {
      manager.appendEvent(runId, event);
    }
    manager.updateRecord(runId, { status: 'completed', completedAt: new Date().toISOString() });
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('loads the run record and a step per event', () => {
    const model = loadReplay(repoRoot, runId);
    expect(model.run.title).toBe('Fix duplicated release');
    expect(model.run.status).toBe('completed');
    expect(model.steps).toHaveLength(13);
    expect(model.steps[0]?.index).toBe(0);
    expect(model.steps[12]?.index).toBe(12);
  });

  it('attributes events to their phase name', () => {
    const model = loadReplay(repoRoot, runId);
    // model_call inside the Implement phase.
    expect(model.steps[2]?.phaseName).toBe('Implement');
    // command_completed inside the Verify phase.
    expect(model.steps[6]?.phaseName).toBe('Verify');
    // run_started is outside any phase.
    expect(model.steps[0]?.phaseName).toBeNull();
  });

  it('accumulates cost and tokens across model_call events', () => {
    const model = loadReplay(repoRoot, runId);
    // Before any model_call.
    expect(model.steps[0]?.costCentsSoFar).toBeNull();
    expect(model.steps[0]?.tokensSoFar).toEqual({ input: 0, output: 0 });
    // After the first model_call (5 cents, 1200/340).
    expect(model.steps[2]?.costCentsSoFar).toBe(5);
    expect(model.steps[2]?.tokensSoFar).toEqual({ input: 1200, output: 340 });
    // After the second model_call (cumulative 8 cents, 2000/460).
    expect(model.steps[8]?.costCentsSoFar).toBe(8);
    expect(model.steps[8]?.tokensSoFar).toEqual({ input: 2000, output: 460 });
    // Final step keeps the cumulative total.
    expect(model.steps[12]?.costCentsSoFar).toBe(8);
  });

  it('produces concise per-event summaries', () => {
    const model = loadReplay(repoRoot, runId);
    const summaries = model.steps.map((step) => step.summary);
    expect(summaries[0]).toContain('run started');
    expect(summaries[1]).toBe('phase Implement started');
    expect(summaries[2]).toBe('model call (1.2k in / 340 out)');
    expect(summaries[3]).toBe('wrote src/release.ts');
    expect(summaries[6]).toBe('ran "npm test" → exit 0');
    expect(summaries[7]).toBe('tests → failed');
    expect(summaries[9]).toBe('patch generated → src/release.ts');
    expect(summaries[10]).toContain('approval requested');
    expect(summaries[12]).toBe('run completed');
  });

  it('reconstructs the state at a cursor: phase, diff, cost, window', () => {
    const model = loadReplay(repoRoot, runId);
    // At the patch_generated step (index 9), inside Verify, with the diff present.
    const state = reconstructStateAt(model, 9);
    expect(state.phaseName).toBe('Verify');
    expect(state.accumulatedDiff).toBe(SAMPLE_DIFF);
    expect(state.costCentsSoFar).toBe(8);
    expect(state.step.index).toBe(9);
    expect(state.recentEvents.length).toBeGreaterThan(0);
    // The window ends at the cursor's event.
    expect(state.recentEvents[state.recentEvents.length - 1]?.type).toBe('patch_generated');
  });

  it('reconstructs an accumulated diff from a file_write before any patch event', () => {
    const model = loadReplay(repoRoot, runId);
    // At the file_write step (index 3) — no patch_generated yet, so the diff
    // comes from the file_write change payload.
    const state = reconstructStateAt(model, 3);
    expect(state.accumulatedDiff).toContain('src/release.ts');
    expect(state.accumulatedDiff).toContain('idempotency guard');
  });

  it('clamps an out-of-range cursor instead of throwing', () => {
    const model = loadReplay(repoRoot, runId);
    expect(reconstructStateAt(model, -5).step.index).toBe(0);
    expect(reconstructStateAt(model, 999).step.index).toBe(model.steps.length - 1);
  });

  it('semantic jumps land on the right steps', () => {
    const model = loadReplay(repoRoot, runId);
    // edit → the first file_write (index 3).
    expect(nextStepOfKind(model, -1, 'edit')).toBe(3);
    // failure → the failed test_result (index 7), not the exit-0 command.
    expect(nextStepOfKind(model, -1, 'failure')).toBe(7);
    // test → the test_result (index 7).
    expect(nextStepOfKind(model, -1, 'test')).toBe(7);
    // command → the command_completed (index 6).
    expect(nextStepOfKind(model, -1, 'command')).toBe(6);
    // approval → the approval_requested (index 10).
    expect(nextStepOfKind(model, -1, 'approval')).toBe(10);
    // phase → the first phase_started (index 1).
    expect(nextStepOfKind(model, -1, 'phase')).toBe(1);
    // From after the first edit, the next edit is the patch_generated (index 9).
    expect(nextStepOfKind(model, 3, 'edit')).toBe(9);
    // No failure after index 7.
    expect(nextStepOfKind(model, 7, 'failure')).toBeNull();
  });

  it('prevStepOfKind walks backwards', () => {
    const model = loadReplay(repoRoot, runId);
    expect(prevStepOfKind(model, 13, 'edit')).toBe(9);
    expect(prevStepOfKind(model, 9, 'edit')).toBe(3);
    expect(prevStepOfKind(model, 3, 'edit')).toBeNull();
  });

  it('computes phase boundaries', () => {
    const model = loadReplay(repoRoot, runId);
    const boundaries = phaseBoundaries(model);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toMatchObject({ phaseName: 'Implement', startIndex: 1, endIndex: 4 });
    expect(boundaries[1]).toMatchObject({ phaseName: 'Verify', startIndex: 5, endIndex: 11 });
  });

  it('round-trips annotations (add → load)', () => {
    expect(loadAnnotations(repoRoot, runId)).toEqual([]);
    const a1 = addAnnotation(repoRoot, runId, { stepIndex: 3, note: 'this is the fix', at: '2026-06-14T10:00:00.000Z' });
    const a2 = addAnnotation(repoRoot, runId, { stepIndex: 7, note: 'tests fail here', at: '2026-06-14T10:01:00.000Z' });
    expect(a1.stepIndex).toBe(3);
    expect(a2.note).toBe('tests fail here');

    const loaded = loadAnnotations(repoRoot, runId);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(a1);
    expect(loaded[1]).toEqual(a2);

    expect(annotationsForStep(loaded, 3)).toEqual([a1]);
    expect(annotationsForStep(loaded, 7)).toEqual([a2]);
    expect(annotationsForStep(loaded, 99)).toEqual([]);
  });
});

describe('replay time-machine model — sparse logs', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('never throws on a run with no events', () => {
    const manager = new RunManager(repoRoot);
    const run = manager.createRun({ title: 'Empty run', autonomyLevel: 1, workflow: 'assist' });
    const model = loadReplay(repoRoot, run.id);
    expect(model.steps).toHaveLength(0);
    const state = reconstructStateAt(model, 0);
    expect(state.accumulatedDiff).toBe('');
    expect(state.costCentsSoFar).toBeNull();
    expect(state.recentEvents).toEqual([]);
    expect(phaseBoundaries(model)).toEqual([]);
    expect(nextStepOfKind(model, -1, 'edit')).toBeNull();
  });

  it('reports null cost when no model_call carries a costCents', () => {
    const manager = new RunManager(repoRoot);
    const run = manager.createRun({ title: 'No-cost run', autonomyLevel: 1, workflow: 'assist' });
    manager.appendEvent(
      run.id,
      createEvent({
        runId: run.id,
        type: 'model_call',
        payload: { model: 'mock-model', inputTokens: 10, outputTokens: 20 },
      }),
    );
    const model = loadReplay(repoRoot, run.id);
    expect(model.steps[0]?.costCentsSoFar).toBeNull();
    expect(model.steps[0]?.tokensSoFar).toEqual({ input: 10, output: 20 });
  });
});
