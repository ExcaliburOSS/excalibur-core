import { describe, expect, it } from 'vitest';
import type { ExcaliburEvent, ExcaliburEventType } from '@excalibur/shared';
import { stripAnsi } from '@excalibur/tui';
import { LiveRail, clampVisibleWidth } from './live-rail';

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

/** A sink that records every raw write, for asserting control sequences. */
function fakeSink(): {
  writeRaw: (t: string) => void;
  all: () => string;
  chunks: () => string[];
  last: () => string;
} {
  const chunks: string[] = [];
  return {
    writeRaw: (t): void => void chunks.push(t),
    all: (): string => chunks.join(''),
    chunks: (): string[] => [...chunks],
    last: (): string => chunks[chunks.length - 1] ?? '',
  };
}

const opts = (over = {}): ConstructorParameters<typeof LiveRail>[1] => ({
  tier: 'none' as const,
  mode: 'dark' as const,
  reduce: { autonomyLabel: 'L3', model: 'groq' },
  animate: false,
  now: () => Date.UTC(2026, 5, 17, 0, 1, 0),
  ...over,
});

describe('clampVisibleWidth', () => {
  it('truncates to the visible width, preserving ANSI codes and resetting at the end', () => {
    const colored = '\x1b[32mhello world this is long\x1b[0m';
    const clamped = clampVisibleWidth(colored, 5);
    expect(stripAnsi(clamped).length).toBe(5); // 5 VISIBLE chars
    expect(stripAnsi(clamped)).toBe('hello');
    expect(clamped).toContain('\x1b[32m'); // color preserved
    expect(clamped.endsWith('\x1b[0m')).toBe(true); // reset so color never bleeds
  });

  it('leaves a line that already fits untouched', () => {
    const line = '\x1b[1mshort\x1b[0m';
    expect(clampVisibleWidth(line, 80)).toBe(line);
  });

  it('does nothing when columns is unknown (0)', () => {
    const line = 'a'.repeat(200);
    expect(clampVisibleWidth(line, 0)).toBe(line);
  });
});

describe('LiveRail', () => {
  it('hides the cursor on start and shows it on stop', () => {
    const sink = fakeSink();
    const rail = new LiveRail(sink, opts());
    rail.start();
    expect(sink.all()).toContain('\x1b[?25l'); // hide
    rail.stop();
    expect(sink.all()).toContain('\x1b[?25h'); // show
  });

  it('redraws in place: a later frame moves the cursor up over the previous one', () => {
    const sink = fakeSink();
    const rail = new LiveRail(sink, opts());
    rail.start();
    rail.push(ev('run_started', { title: 't' }));
    rail.push(ev('phase_started', { name: 'Analyze' }, 'p1'));
    rail.push(ev('phase_started', { name: 'Patch' }, 'p2'));
    const out = sink.all();
    // A cursor-up control (\x1b[<n>A) appears once the rail has grown.
    expect(/\x1b\[\d+A/.test(out)).toBe(true);
    // The painted content (stripped of ANSI) carries the phase names.
    const plain = stripAnsi(out);
    expect(plain).toContain('Analyze');
    expect(plain).toContain('Patch');
    expect(plain).toContain('L3'); // status line
  });

  it('does not move up on the very first frame', () => {
    const sink = fakeSink();
    const rail = new LiveRail(sink, opts());
    rail.start(); // first render
    // Nothing before the first frame should be a cursor-up move.
    const firstFrame = sink.all();
    expect(/\x1b\[\d+A/.test(firstFrame)).toBe(false);
  });

  it('pause settles the frame and suspends redraws; resume repaints', () => {
    const sink = fakeSink();
    const rail = new LiveRail(sink, opts());
    rail.start();
    rail.push(ev('phase_started', { name: 'Analyze' }, 'p1'));
    const beforePause = sink.all().length;
    rail.pause();
    expect(sink.all()).toContain('\x1b[?25h'); // cursor restored for the prompt
    // While paused, pushing events accumulates but does NOT draw.
    const afterPause = sink.all().length;
    rail.push(ev('file_write', { path: 'a.ts' }, 'p1'));
    expect(sink.all().length).toBe(afterPause);
    expect(afterPause).toBeGreaterThan(beforePause);
    // Resume repaints, now including the accumulated event.
    rail.resume();
    expect(stripAnsi(sink.all())).toContain('write a.ts');
  });

  it('wraps frames in DEC 2026 synchronized output for flicker-free atomic paint', () => {
    const sink = fakeSink();
    const rail = new LiveRail(sink, opts());
    rail.start();
    rail.push(ev('phase_started', { name: 'Analyze' }, 'p1'));
    const out = sink.all();
    expect(out).toContain('\x1b[?2026h'); // begin synchronized update
    expect(out).toContain('\x1b[?2026l'); // end synchronized update
  });

  it('can disable synchronized output via sync:false (graceful for odd terminals)', () => {
    const sink = fakeSink();
    const rail = new LiveRail(sink, opts({ sync: false }));
    rail.start();
    rail.push(ev('phase_started', { name: 'Analyze' }, 'p1'));
    expect(sink.all()).not.toContain('\x1b[?2026');
  });

  it('differential redraw: a bottom-only change does NOT repaint the stable top', () => {
    const sink = fakeSink();
    const rail = new LiveRail(sink, opts());
    rail.start();
    rail.push(ev('run_started', { title: 'UNIQUE_TITLE_TOKEN' }));
    rail.push(ev('phase_started', { name: 'Analyze' }, 'p1'));
    // A later event that only advances the bottom (a tool action under the
    // active phase) must NOT rewrite the header that carries the title.
    rail.push(ev('file_write', { path: 'z.ts' }, 'p1'));
    const lastFrame = stripAnsi(sink.last());
    expect(lastFrame).toContain('write z.ts'); // the change WAS painted
    expect(lastFrame).not.toContain('UNIQUE_TITLE_TOKEN'); // the stable top was NOT
  });

  it('ignores events after stop', () => {
    const sink = fakeSink();
    const rail = new LiveRail(sink, opts());
    rail.start();
    rail.stop();
    const after = sink.all().length;
    rail.push(ev('phase_started', { name: 'Late' }, 'p9'));
    expect(sink.all().length).toBe(after);
  });
});
