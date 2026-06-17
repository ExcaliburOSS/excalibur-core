import { describe, expect, it } from 'vitest';
import type { ExcaliburEvent, ExcaliburEventType } from '@excalibur/shared';
import { reduceRail } from './rail-reducer.js';
import { renderRail } from './rail-render.js';
import { renderPlanCard } from './rail-plan.js';
import type { ColorTier } from './color.js';
import type { ThemeMode } from './theme.js';

/**
 * Golden snapshots (build STEP 10): they lock the EXACT rendered bytes of the
 * LIVING RAIL across every colour tier and both backgrounds, so an accidental
 * format/colour regression fails loudly. ANSI escapes are shown as `ESC` for a
 * readable, stable snapshot. They also pin the core invariant — folding the full
 * stream (replay) is byte-identical to folding it incrementally (live) — because
 * `reduceRail` is a pure function of the event array.
 */

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

/** A representative run: context done, implement ACTIVE with its tool + patch
 * stream (so the golden locks the per-tool glyphs and the diffstat note). */
const STREAM: ExcaliburEvent[] = [
  ev('run_started', { title: 'Fix the webhook retry bug' }),
  ev('phase_started', { name: 'Context' }, 'p-ctx'),
  ev('file_read', { path: 'src/webhook.ts' }, 'p-ctx'),
  ev('phase_completed', { detail: '1 file' }, 'p-ctx'),
  ev('phase_started', { name: 'Implement' }, 'p-impl'),
  ev('model_call', { model: 'qwen', costCents: 7 }, 'p-impl'),
  ev('file_write', { path: 'src/webhook.ts' }, 'p-impl'),
  ev('patch_generated', { diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n' }, 'p-impl'),
  ev('command_started', { command: 'pnpm test' }, 'p-impl'),
  ev('command_completed', { exitCode: 0 }, 'p-impl'),
];

const esc = (lines: string[]): string => lines.join('\n').replace(/\x1b/g, 'ESC');

describe('golden: renderRail', () => {
  const model = reduceRail(STREAM, { autonomyLabel: 'L3', safety: 'standard-safe', model: 'qwen' });
  const tiers: ColorTier[] = ['none', 'ansi16', 'ansi256', 'truecolor'];
  const modes: ThemeMode[] = ['dark', 'light'];

  for (const tier of tiers) {
    for (const mode of modes) {
      it(`tier=${tier} mode=${mode}`, () => {
        // spinnerFrame fixed so the running glyph is deterministic.
        expect(esc(renderRail(model, { tier, mode, spinnerFrame: 0 }))).toMatchSnapshot();
      });
    }
  }
});

describe('golden: renderPlanCard', () => {
  it('truecolor dark', () => {
    const card = renderPlanCard(
      {
        workflowName: 'Fast Fix',
        workflowId: 'fast-fix',
        autonomyLabel: 'L3 — Implement in Branch',
        phases: [
          { name: 'Analyze', type: 'assistant_interaction' },
          { name: 'Patch', type: 'patch_generation' },
          { name: 'Verify', type: 'command_group', optional: true },
        ],
        swarmReason: 'Sized to 2 agents',
        gate: '[Enter] run · [m] mode · [c] cancel',
      },
      { tier: 'truecolor', mode: 'dark' },
    );
    expect(esc(card)).toMatchSnapshot();
  });
});

describe('invariant: live == replay', () => {
  it('folding the full stream equals folding it incrementally', () => {
    const opts = { autonomyLabel: 'L3', model: 'qwen' };
    const replay = renderRail(reduceRail(STREAM, opts), { spinnerFrame: 0 });
    // "Live": reduce after each event; the last frame is the full fold.
    let live: string[] = [];
    for (let i = 1; i <= STREAM.length; i += 1) {
      live = renderRail(reduceRail(STREAM.slice(0, i), opts), { spinnerFrame: 0 });
    }
    expect(live).toEqual(replay);
  });
});
