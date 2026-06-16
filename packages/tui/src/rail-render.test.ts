import { describe, expect, it } from 'vitest';
import { stripAnsi } from './color.js';
import { renderRail } from './rail-render.js';
import type { RailModel } from './rail-types.js';

const model = (over: Partial<RailModel> = {}): RailModel => ({
  runId: 'run_1',
  title: 'Fix the bug',
  autonomyLabel: 'L3',
  phases: [
    { id: 'a', name: 'Context', state: 'completed', detail: '1 file' },
    {
      id: 'b',
      name: 'Implement',
      state: 'running',
      events: [
        { text: 'write src/a.ts', note: '+24 −6' },
        { text: '$ pnpm test' },
        { text: 'exit 0' },
      ],
    },
    { id: 'c', name: 'Verify', state: 'pending' },
  ],
  status: { elapsedMs: 64_000, costCents: 18, safety: 'standard-safe', push: false, model: 'qwen' },
  done: false,
  errored: false,
  ...over,
});

describe('renderRail', () => {
  it('renders a node per phase + the ACTIVE phase events + a status line', () => {
    const lines = renderRail(model());
    const text = lines.join('\n');
    // A node per phase.
    expect(text).toContain('Context');
    expect(text).toContain('Implement');
    expect(text).toContain('Verify');
    expect(text).toContain('1 file'); // completed phase detail
    // Only the active (Implement) phase expands its events.
    expect(text).toContain('write src/a.ts');
    expect(text).toContain('+24 −6'); // the note annotation
    expect(text).toContain('$ pnpm test');
    expect(text).toContain('exit 0');
    // Status line: autonomy · safety · cost · elapsed · push · model.
    const status = lines[lines.length - 1]!;
    expect(status).toContain('L3');
    expect(status).toContain('standard-safe');
    expect(status).toContain('1m04s');
    expect(status).toContain('no push');
    expect(status).toContain('qwen');
  });

  it('does NOT expand a non-active (pending/completed) phase', () => {
    const lines = renderRail(
      model({
        phases: [
          { id: 'a', name: 'A', state: 'completed', events: [{ text: 'should-not-show' }] },
          { id: 'b', name: 'B', state: 'running', events: [{ text: 'visible-here' }] },
        ],
      }),
    );
    const text = lines.join('\n');
    expect(text).not.toContain('should-not-show');
    expect(text).toContain('visible-here');
  });

  it('renders an approval node when waiting', () => {
    const lines = renderRail(
      model({ approval: { question: 'Apply edit to charge.ts?', options: '[y/N/always]' } }),
    );
    const text = lines.join('\n');
    expect(text).toContain('Apply edit to charge.ts?');
    expect(text).toContain('[y/N/always]');
  });

  it('the coloured form embeds ANSI and strips back to the plain form byte-identically', () => {
    const m = model({ approval: { question: 'Apply?', options: '[y/N]' } });
    const plain = renderRail(m);
    const truecolor = renderRail(m, { tier: 'truecolor' });
    const ansi256 = renderRail(m, { tier: 'ansi256', mode: 'light' });
    // Colour is actually applied (escape sequences present)…
    expect(truecolor.join('\n')).toContain('\x1b[38;2;');
    expect(ansi256.join('\n')).toContain('\x1b[38;5;');
    // …and removing it reproduces the plain render exactly (live=scrub=replay).
    expect(truecolor.map(stripAnsi)).toEqual(plain);
    expect(ansi256.map(stripAnsi)).toEqual(plain);
  });

  it('tier none is byte-identical to omitting the option', () => {
    const m = model();
    expect(renderRail(m, { tier: 'none' })).toEqual(renderRail(m));
  });
});
