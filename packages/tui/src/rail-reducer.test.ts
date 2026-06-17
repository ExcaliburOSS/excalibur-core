import { describe, expect, it } from 'vitest';
import type { ExcaliburEvent, ExcaliburEventType } from '@excalibur/shared';
import { reduceRail } from './rail-reducer.js';

let seq = 0;
function ev(
  type: ExcaliburEventType,
  payload: Record<string, unknown> = {},
  phaseId: string | null = null,
): ExcaliburEvent {
  seq += 1;
  return {
    id: `evt_${seq}`,
    runId: 'run_1',
    type,
    timestamp: new Date(Date.UTC(2026, 5, 17, 0, 0, seq)).toISOString(),
    phaseId,
    sessionId: 'sess_1',
    payload,
  };
}

describe('reduceRail', () => {
  it('folds a run into phases with correct states, events, cost and done', () => {
    const events = [
      ev('run_started', { title: 'Fix the bug' }),
      ev('phase_started', { name: 'Context' }, 'p-context'),
      ev('file_read', { path: 'src/a.ts' }, 'p-context'),
      ev('phase_completed', { detail: '1 file' }, 'p-context'),
      ev('phase_started', { name: 'Implement' }, 'p-impl'),
      ev('model_call', { model: 'qwen', costCents: 3, inputTokens: 1200, outputTokens: 340 }, 'p-impl'),
      ev('file_write', { path: 'src/a.ts' }, 'p-impl'),
      ev('command_started', { command: 'pnpm test' }, 'p-impl'),
      ev('command_completed', { exitCode: 0 }, 'p-impl'),
      ev('test_result', { status: 'passed' }, 'p-impl'),
      ev('phase_completed', {}, 'p-impl'),
      ev('run_completed', { status: 'completed' }),
    ];
    const rail = reduceRail(events, { model: 'qwen', safety: 'standard-safe' });

    expect(rail.runId).toBe('run_1');
    expect(rail.title).toBe('Fix the bug');
    expect(rail.done).toBe(true);
    expect(rail.errored).toBe(false);
    expect(rail.phases.map((p) => `${p.name}:${p.state}`)).toEqual([
      'Context:completed',
      'Implement:completed',
    ]);
    expect(rail.phases[0]?.detail).toBe('1 file');
    // Implement's within-phase events (model_call folds into cost, not a line).
    const implTexts = rail.phases[1]?.events?.map((e) => e.text) ?? [];
    expect(implTexts).toEqual(['write src/a.ts', '$ pnpm test', 'exit 0', 'tests passed']);
    // Each event carries its semantic kind (→ a per-tool glyph at render time).
    const implKinds = rail.phases[1]?.events?.map((e) => e.kind) ?? [];
    expect(implKinds).toEqual(['write', 'command', 'exit', 'test']);
    expect(rail.status.costCents).toBe(3);
    expect(rail.status.model).toBe('qwen');
    expect(rail.status.elapsedMs).toBeGreaterThan(0);
    expect(rail.status.inputTokens).toBe(1200);
    expect(rail.status.outputTokens).toBe(340);
    // Per-phase duration + cost (DX battery): Context ran 2s (its events span
    // 2s), Implement ran 6s and carries the model_call's 3¢.
    expect(rail.phases[0]?.durationMs).toBe(2000);
    expect(rail.phases[1]?.durationMs).toBe(6000);
    expect(rail.phases[1]?.costCents).toBe(3);
    expect(rail.phases[0]?.costCents).toBeUndefined(); // Context made no model call
  });

  it('marks the active phase waiting on an approval, and clears it on approve', () => {
    const waiting = reduceRail([
      ev('phase_started', { name: 'Implement' }, 'p1'),
      ev('approval_requested', { message: 'Apply edit to charge.ts?' }, 'p1'),
    ]);
    expect(waiting.phases[0]?.state).toBe('waiting');
    expect(waiting.approval?.question).toContain('charge.ts');

    const approved = reduceRail([
      ev('phase_started', { name: 'Implement' }, 'p1'),
      ev('approval_requested', { message: 'ok?' }, 'p1'),
      ev('approval_approved', {}, 'p1'),
    ]);
    expect(approved.phases[0]?.state).toBe('running');
    expect(approved.approval).toBeUndefined();
  });

  it('folds a patch_generated diff into a diffstat note on the patch node', () => {
    const diff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-x\n+y\n+z\n`;
    const rail = reduceRail([
      ev('phase_started', { name: 'Patch' }, 'p1'),
      ev('patch_generated', { diff }, 'p1'),
    ]);
    const patchEvent = rail.phases[0]?.events?.[0];
    expect(patchEvent?.kind).toBe('patch');
    expect(patchEvent?.note).toBe('+2 −1 · 1 file');
  });

  it('marks the phase failed + errored on an error event', () => {
    const rail = reduceRail([
      ev('phase_started', { name: 'Verify' }, 'p1'),
      ev('error', { message: 'TS2345 type mismatch' }, 'p1'),
    ]);
    expect(rail.errored).toBe(true);
    expect(rail.phases[0]?.state).toBe('failed');
    expect(rail.phases[0]?.events?.[0]?.text).toContain('TS2345');
  });

  it('a PREFIX of the stream reduces to a consistent in-progress rail (scrub = live)', () => {
    const full = [
      ev('run_started', { title: 't' }),
      ev('phase_started', { name: 'A' }, 'a'),
      ev('phase_completed', {}, 'a'),
      ev('phase_started', { name: 'B' }, 'b'),
    ];
    const mid = reduceRail(full.slice(0, 3)); // up to A completed, B not started
    expect(mid.phases.map((p) => `${p.name}:${p.state}`)).toEqual(['A:completed']);
    expect(mid.done).toBe(false);
    const later = reduceRail(full); // B now running
    expect(later.phases.map((p) => `${p.name}:${p.state}`)).toEqual(['A:completed', 'B:running']);
  });
});
