import { describe, expect, it } from 'vitest';
import { stripAnsi } from '@excalibur/tui';
import { LiveLanes } from './live-lanes';

function fakeSink(): { writeRaw: (t: string) => void; all: () => string } {
  const chunks: string[] = [];
  return { writeRaw: (t): void => void chunks.push(t), all: (): string => chunks.join('') };
}

const opts = (over = {}) => ({
  tier: 'none' as const,
  mode: 'dark' as const,
  lanes: [
    { id: 'a', title: 'rate-limit login' },
    { id: 'b', title: 'rate-limit signup' },
  ],
  ...over,
});

describe('LiveLanes', () => {
  it('renders all lanes on start and animates each as progress arrives', () => {
    const sink = fakeSink();
    const live = new LiveLanes(sink, opts());
    live.start();
    expect(sink.all()).toContain('\x1b[?25l'); // hide cursor
    const plain = stripAnsi(sink.all());
    expect(plain).toContain('rate-limit login');
    expect(plain).toContain('rate-limit signup');

    live.update({ index: 0, id: 'a', phase: 'started' });
    live.update({ index: 0, id: 'a', phase: 'settled' });
    live.update({ index: 1, id: 'b', phase: 'settled', failed: true });
    // Still shows both lanes after updates (panel repainted in place).
    const after = stripAnsi(sink.all());
    expect(after).toContain('rate-limit login');
    expect(after).toContain('rate-limit signup');
  });

  it('wraps frames in synchronized output (flicker-free)', () => {
    const sink = fakeSink();
    const live = new LiveLanes(sink, opts());
    live.start();
    expect(sink.all()).toContain('\x1b[?2026h');
    expect(sink.all()).toContain('\x1b[?2026l');
  });

  it('finish() erases the live panel and restores the cursor', () => {
    const sink = fakeSink();
    const live = new LiveLanes(sink, opts());
    live.start();
    live.finish();
    const out = sink.all();
    expect(out).toContain('\x1b[?25h'); // cursor restored
    expect(/\x1b\[\d+A\x1b\[0J/.test(out)).toBe(true); // moved up + cleared the panel
    // Updates after finish are ignored (no further writes).
    const len = out.length;
    live.update({ index: 0, id: 'a', phase: 'started' });
    expect(sink.all().length).toBe(len);
  });
});
