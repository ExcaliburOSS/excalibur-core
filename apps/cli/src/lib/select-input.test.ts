import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { computeWindow, reduceSelectKey, renderChoiceLine, type SelectState } from './select-input';
import type { ParsedKey } from './raw-input';
import { resolveSelectKeymap } from './keymap';
import { Ui } from '../ui';

/**
 * The select reducer is PURE, so it is tested without a TTY by feeding synthetic
 * keys and asserting the next index + emitted action. The interactive shell is
 * tested with a fake TTY stream (isTTY + recorded setRawMode + a TTY stdout) so
 * the raw-mode lifecycle and arrow→Enter wiring are covered without a terminal.
 */

const key = (k: Partial<ParsedKey>): ParsedKey => k;
const at = (index: number, query = ''): SelectState => ({ index, query });

describe('reduceSelectKey (pure state machine)', () => {
  it('↓/j advance and wrap at the end', () => {
    expect(reduceSelectKey(at(0), key({ name: 'down' }), 3)).toEqual({
      state: { index: 1, query: '' },
      action: { type: 'move' },
    });
    expect(reduceSelectKey(at(2), key({ name: 'down' }), 3).state.index).toBe(0); // wrap
    expect(reduceSelectKey(at(0), key({ name: 'j' }), 3).state.index).toBe(1);
  });

  it('↑/k retreat and wrap at the start', () => {
    expect(reduceSelectKey(at(1), key({ name: 'up' }), 3).state.index).toBe(0);
    expect(reduceSelectKey(at(0), key({ name: 'up' }), 3).state.index).toBe(2); // wrap
    expect(reduceSelectKey(at(2), key({ name: 'k' }), 3).state.index).toBe(1);
  });

  it('home/end jump to the edges', () => {
    expect(reduceSelectKey(at(2), key({ name: 'home' }), 4).state.index).toBe(0);
    expect(reduceSelectKey(at(0), key({ name: 'end' }), 4).state.index).toBe(3);
  });

  it('honors a custom keymap (P1.13b): rebound accept/cancel + nav keys', () => {
    const km = resolveSelectKeymap({ accept: 'l', cancel: 'q', down: ['s', 'down'] });
    // Rebound accept (sequence 'l') submits.
    expect(reduceSelectKey(at(1), key({ name: 'l', sequence: 'l' }), 3, km).action).toEqual({
      type: 'submit',
      index: 1,
    });
    // Rebound cancel.
    expect(reduceSelectKey(at(0), key({ sequence: 'q' }), 3, km).action).toEqual({
      type: 'cancel',
    });
    // Rebound down ('s') still advances; the default 'down' arrow still works too.
    expect(reduceSelectKey(at(0), key({ name: 's', sequence: 's' }), 3, km).state.index).toBe(1);
    expect(reduceSelectKey(at(0), key({ name: 'down' }), 3, km).state.index).toBe(1);
    // The default Enter is NOT bound to accept anymore (accept was remapped to 'l').
    expect(reduceSelectKey(at(1), key({ name: 'return' }), 3, km).action).toEqual({ type: 'none' });
  });

  it('Enter submits the current index', () => {
    expect(reduceSelectKey(at(2), key({ name: 'return' }), 4).action).toEqual({
      type: 'submit',
      index: 2,
    });
  });

  it('a digit 1–9 jumps to that row AND submits (no active filter, short list)', () => {
    expect(reduceSelectKey(at(0), key({ sequence: '3' }), 5).action).toEqual({
      type: 'submit',
      index: 2,
    });
    // An out-of-range digit is not a jump → it extends the type-ahead filter.
    const r = reduceSelectKey(at(0), key({ sequence: '9' }), 3);
    expect(r.action).toEqual({ type: 'filter' });
    expect(r.state.query).toBe('9');
  });

  it('type-ahead: printable chars build the filter, backspace trims, Esc clears then cancels', () => {
    // Typing 'd' (not a nav key) appends to the query and resets the highlight.
    const typed = reduceSelectKey(at(2, 'gl'), key({ name: 'd', sequence: 'd' }), 7);
    expect(typed.action).toEqual({ type: 'filter' });
    expect(typed.state).toEqual({ index: 0, query: 'gld' });
    // Backspace edits the filter.
    const back = reduceSelectKey(at(0, 'glm'), key({ name: 'backspace' }), 1);
    expect(back.state.query).toBe('gl');
    expect(back.action).toEqual({ type: 'filter' });
    // Esc with a filter clears it (no cancel yet); Esc with no filter cancels.
    expect(reduceSelectKey(at(0, 'gl'), key({ name: 'escape' }), 1).action).toEqual({
      type: 'filter',
    });
    expect(reduceSelectKey(at(0, 'gl'), key({ name: 'escape' }), 1).state.query).toBe('');
    expect(reduceSelectKey(at(0, ''), key({ name: 'escape' }), 1).action).toEqual({
      type: 'cancel',
    });
  });

  it('Esc cancels; Ctrl-C raises sigint; modifier combos never navigate', () => {
    expect(reduceSelectKey(at(1), key({ name: 'escape' }), 3).action).toEqual({ type: 'cancel' });
    expect(reduceSelectKey(at(1), key({ ctrl: true, name: 'c' }), 3).action).toEqual({
      type: 'sigint',
    });
    // Ctrl-/Meta + an arrow is a no-op (single-key rule: no modifier combos).
    expect(reduceSelectKey(at(1), key({ ctrl: true, name: 'down' }), 3).action).toEqual({
      type: 'none',
    });
    expect(reduceSelectKey(at(1), key({ meta: true, name: 'up' }), 3).action).toEqual({
      type: 'none',
    });
  });
});

describe('computeWindow', () => {
  it('returns the whole range when everything fits', () => {
    expect(computeWindow(0, 5, 8)).toEqual({ start: 0, end: 5 });
    expect(computeWindow(4, 5, 5)).toEqual({ start: 0, end: 5 });
  });
  it('scrolls to keep the active row on screen, clamped at the ends', () => {
    expect(computeWindow(0, 15, 8)).toEqual({ start: 0, end: 8 }); // top
    expect(computeWindow(14, 15, 8)).toEqual({ start: 7, end: 15 }); // bottom clamp
    const mid = computeWindow(8, 15, 8); // centered-ish
    expect(mid.end - mid.start).toBe(8);
    expect(8).toBeGreaterThanOrEqual(mid.start);
    expect(8).toBeLessThan(mid.end);
  });
});

describe('renderChoiceLine', () => {
  it('marks the active row with ❯ and a number, plain otherwise', () => {
    const active = renderChoiceLine({ label: 'Kimi', hint: 'recommended' }, true, 4);
    const inactive = renderChoiceLine({ label: 'Groq' }, false, 5);
    expect(active).toContain('❯');
    expect(active).toContain('Kimi');
    expect(active).toContain('recommended');
    expect(inactive).not.toContain('❯');
    expect(inactive).toContain('Groq');
    expect(inactive).toContain('5.');
  });
});

// --- interactive shell (fake TTY) ------------------------------------------

function fakeTty(): PassThrough & {
  isTTY: boolean;
  rawCalls: boolean[];
  setRawMode: (v: boolean) => unknown;
} {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    rawCalls: boolean[];
    setRawMode: (v: boolean) => unknown;
  };
  s.isTTY = true;
  s.rawCalls = [];
  s.setRawMode = (v: boolean): unknown => {
    s.rawCalls.push(v);
    return s;
  };
  return s;
}

function ttyOut(): { write: (s: string) => boolean; isTTY: boolean; text: string } {
  const chunks: string[] = [];
  return {
    isTTY: true,
    write: (s: string): boolean => {
      chunks.push(s);
      return true;
    },
    get text(): string {
      return chunks.join('');
    },
  };
}

describe('Ui.select interactive arrow chooser (fake TTY)', () => {
  it('moves with ↓ and resolves the highlighted index on Enter, restoring cooked mode', async () => {
    const stdin = fakeTty();
    const out = ttyOut();
    const ui = new Ui({
      stdin,
      stdout: out as unknown as NodeJS.WritableStream,
      stderr: new PassThrough() as unknown as NodeJS.WritableStream,
      interactive: true,
    });
    const pending = ui.select('Pick a provider', [{ label: 'a' }, { label: 'b' }, { label: 'c' }], {
      defaultIndex: 0,
    });
    expect(stdin.rawCalls).toContain(true); // raw enabled

    stdin.emit('keypress', undefined, { name: 'down' });
    stdin.emit('keypress', undefined, { name: 'down' });
    stdin.emit('keypress', '\r', { name: 'return' });

    await expect(pending).resolves.toBe(2);
    expect(stdin.rawCalls).toContain(false); // cooked restored on finish
    expect(out.text).toContain('Pick a provider');
  });

  it('type-ahead: typing filters the list and Enter resolves the ORIGINAL index', async () => {
    const stdin = fakeTty();
    const out = ttyOut();
    const ui = new Ui({
      stdin,
      stdout: out as unknown as NodeJS.WritableStream,
      stderr: new PassThrough() as unknown as NodeJS.WritableStream,
      interactive: true,
    });
    const pending = ui.select(
      'Provider',
      [{ label: 'Kimi' }, { label: 'MiniMax' }, { label: 'DeepSeek' }, { label: 'Groq' }],
      { defaultIndex: 0 },
    );
    // Type "deep" → filters to DeepSeek (original index 2); Enter selects it.
    for (const ch of 'deep') {
      stdin.emit('keypress', ch, { name: ch, sequence: ch });
    }
    stdin.emit('keypress', '\r', { name: 'return' });
    await expect(pending).resolves.toBe(2);
    expect(out.text).toContain('filter:');
  });

  it('falls back to the numbered chooser when stdin is not a TTY (arrow mode needs BOTH)', async () => {
    // A non-TTY stdin → the deterministic numbered path even with a TTY stdout:
    // type a number, no raw mode. (Mirrors scripted-stdin tests/CI.)
    const stdin = Readable.from(['2\n']);
    const out = new Writable({ write: (_c, _e, cb): void => cb() });
    const ui = new Ui({
      stdin,
      stdout: out,
      stderr: new Writable({ write: (_c, _e, cb): void => cb() }),
      interactive: true,
    });
    const index = await ui.select('Pick', [{ label: 'a' }, { label: 'b' }], { defaultIndex: 0 });
    expect(index).toBe(1);
  });
});
