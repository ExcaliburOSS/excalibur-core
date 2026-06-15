import { describe, expect, it } from 'vitest';
import { Spinner, isTtyStream } from './spinner';

/**
 * The spinner must be INVISIBLE off a TTY (tests, CI, pipes) — no writes, no
 * timers — and, when enabled, render a frame on start and erase its OWN line on
 * stop without touching unrelated output.
 */

function recorder(): { stream: NodeJS.WritableStream; chunks: string[] } {
  const chunks: string[] = [];
  const stream = {
    write: (s: string): boolean => {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, chunks };
}

describe('Spinner', () => {
  it('is a complete no-op when disabled (no writes, no timer)', () => {
    const { stream, chunks } = recorder();
    const sp = new Spinner(stream, { enabled: false });
    sp.start(() => 'Thinking…');
    sp.stop();
    expect(chunks).toHaveLength(0);
  });

  it('renders a frame on start and erases ONE line on stop when enabled', () => {
    const { stream, chunks } = recorder();
    // A long interval so only the synchronous first tick fires.
    const sp = new Spinner(stream, { enabled: true, unicode: true, intervalMs: 100000 });
    sp.start(() => 'Implementing… 1.2k tok');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.join('')).toContain('Implementing… 1.2k tok');

    const before = chunks.length;
    sp.stop();
    expect(chunks.length).toBe(before + 1); // exactly one erase write
    expect(chunks[chunks.length - 1]).toContain('[2K'); // clears the line
  });

  it('stop() with no frame on screen writes nothing (no stray erase)', () => {
    const { stream, chunks } = recorder();
    const sp = new Spinner(stream, { enabled: true, intervalMs: 100000 });
    sp.stop();
    expect(chunks).toHaveLength(0);
  });

  it('cancel() stops now and prevents any re-arm (Ctrl-C semantics)', () => {
    const { stream, chunks } = recorder();
    const sp = new Spinner(stream, { enabled: true, intervalMs: 100000 });
    sp.start(() => 'Thinking…');
    const afterStart = chunks.length;
    sp.cancel(); // erases its line (one write) and disables further frames
    expect(chunks.length).toBe(afterStart + 1);
    sp.start(() => 'Should not show'); // re-arm must be a no-op after cancel
    expect(chunks.length).toBe(afterStart + 1);
    expect(chunks.join('')).not.toContain('Should not show');
  });

  it('falls back to ASCII frames when unicode is false', () => {
    const { stream, chunks } = recorder();
    const sp = new Spinner(stream, { enabled: true, unicode: false, intervalMs: 100000 });
    sp.start(() => 'x');
    sp.stop();
    expect(chunks.join('')).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

describe('isTtyStream', () => {
  it('is true only for a real TTY stream', () => {
    expect(isTtyStream({ isTTY: true } as unknown as NodeJS.WritableStream)).toBe(true);
    expect(isTtyStream({ isTTY: false } as unknown as NodeJS.WritableStream)).toBe(false);
    expect(isTtyStream({} as unknown as NodeJS.WritableStream)).toBe(false);
  });
});
