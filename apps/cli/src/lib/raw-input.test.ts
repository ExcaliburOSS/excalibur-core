import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initialRawState,
  instantGhost,
  reduceKey,
  renderInput,
  type ParsedKey,
  type RawInputState,
} from './raw-input';
import { REWIND_SENTINEL, Ui } from '../ui';

/**
 * The raw-input reducer is PURE, so it is tested without a TTY by feeding
 * synthetic keys and asserting the next state + emitted action. The shell is
 * tested with a fake TTY stream (isTTY + recorded setRawMode) so the raw-mode
 * lifecycle and Enter/ESC wiring are covered without a real terminal.
 */

const key = (k: Partial<ParsedKey>): ParsedKey => k;
const prompt = (over: Partial<RawInputState> = {}): RawInputState => ({
  ...initialRawState(),
  awaiting: true,
  ...over,
});

describe('reduceKey (pure state machine)', () => {
  it('inserts printable chars at the cursor and advances it', () => {
    let s = prompt();
    s = reduceKey(s, key({ name: 'h', sequence: 'h' })).state;
    s = reduceKey(s, key({ name: 'i', sequence: 'i' })).state;
    expect(s.buffer).toBe('hi');
    expect(s.cursor).toBe(2);
    // insert in the middle
    s = reduceKey({ ...s, cursor: 1 }, key({ name: 'x', sequence: 'x' })).state;
    expect(s.buffer).toBe('hxi');
    expect(s.cursor).toBe(2);
  });

  it('handles backspace, delete, and cursor moves', () => {
    let s = prompt({ buffer: 'abc', cursor: 3 });
    s = reduceKey(s, key({ name: 'backspace' })).state;
    expect(s.buffer).toBe('ab');
    s = reduceKey(s, key({ name: 'left' })).state; // cursor 2→1
    s = reduceKey(s, key({ name: 'delete' })).state; // removes 'b'
    expect(s.buffer).toBe('a');
    s = reduceKey(prompt({ buffer: 'abc', cursor: 1 }), key({ name: 'home' })).state;
    expect(s.cursor).toBe(0);
    s = reduceKey(prompt({ buffer: 'abc', cursor: 1 }), key({ name: 'end' })).state;
    expect(s.cursor).toBe(3);
  });

  it('Enter submits the line, resets the buffer, and prepends to history', () => {
    const s = prompt({ buffer: 'run tests', cursor: 9 });
    const r = reduceKey(s, key({ name: 'return' }));
    expect(r.action).toEqual({ type: 'submit', line: 'run tests' });
    expect(r.state.buffer).toBe('');
    expect(r.state.cursor).toBe(0);
    expect(r.state.history[0]).toBe('run tests');
  });

  it('Ctrl-C → sigint; Ctrl-D on empty → eof; Ctrl-D non-empty → none', () => {
    expect(reduceKey(prompt(), key({ ctrl: true, name: 'c' })).action).toEqual({ type: 'sigint' });
    expect(reduceKey(prompt(), key({ ctrl: true, name: 'd' })).action).toEqual({ type: 'eof' });
    expect(reduceKey(prompt({ buffer: 'x', cursor: 1 }), key({ ctrl: true, name: 'd' })).action).toEqual({
      type: 'none',
    });
  });

  it('Ctrl-A/E move to ends and Ctrl-U kills to line start', () => {
    expect(reduceKey(prompt({ buffer: 'abc', cursor: 3 }), key({ ctrl: true, name: 'a' })).state.cursor).toBe(0);
    expect(reduceKey(prompt({ buffer: 'abc', cursor: 0 }), key({ ctrl: true, name: 'e' })).state.cursor).toBe(3);
    const killed = reduceKey(prompt({ buffer: 'abcdef', cursor: 3 }), key({ ctrl: true, name: 'u' })).state;
    expect(killed.buffer).toBe('def');
    expect(killed.cursor).toBe(0);
  });

  it('history ↑ recalls older entries (saving the draft) and ↓ restores it', () => {
    let s = prompt({ buffer: 'dr', cursor: 2, history: ['second', 'first'] });
    s = reduceKey(s, key({ name: 'up' })).state; // → 'second', draft saved
    expect(s.buffer).toBe('second');
    expect(s.draft).toBe('dr');
    s = reduceKey(s, key({ name: 'up' })).state; // → 'first'
    expect(s.buffer).toBe('first');
    s = reduceKey(s, key({ name: 'down' })).state; // → 'second'
    expect(s.buffer).toBe('second');
    s = reduceKey(s, key({ name: 'down' })).state; // → draft restored
    expect(s.buffer).toBe('dr');
    expect(s.historyIndex).toBe(-1);
  });

  it('↓ on the EMPTY live line opens the Session Log (the down-into-history gesture)', () => {
    const s = prompt({ buffer: '', cursor: 0, history: ['prev'] });
    const { action } = reduceKey(s, key({ name: 'down' }));
    expect(action).toEqual({ type: 'open_log' });
  });

  it('↓ with a half-typed draft stays a no-op (never interrupts the draft)', () => {
    const s = prompt({ buffer: 'dr', cursor: 2, history: ['prev'] });
    const { action } = reduceKey(s, key({ name: 'down' }));
    expect(action.type).toBe('none');
  });

  it('ESC: aborts a turn when NOT awaiting; clears the buffer when awaiting', () => {
    // not awaiting + mode turn → abort
    const turn = { ...initialRawState(), mode: 'turn' as const, awaiting: false };
    expect(reduceKey(turn, key({ name: 'escape' })).action).toEqual({ type: 'abort' });
    // not awaiting + mode prompt → ignored (no abort)
    const idle = { ...initialRawState(), awaiting: false };
    expect(reduceKey(idle, key({ name: 'escape' })).action).toEqual({ type: 'none' });
    // awaiting → clears the buffer, never aborts
    const r = reduceKey(prompt({ buffer: 'half-typed', cursor: 9, mode: 'turn' }), key({ name: 'escape' }));
    expect(r.action).toEqual({ type: 'none' });
    expect(r.state.buffer).toBe('');
  });

  it('Esc-Esc at the prompt: first ESC primes, a second consecutive ESC opens rewind', () => {
    // First ESC at the prompt clears the line AND primes the repeat.
    const first = reduceKey(prompt({ buffer: 'draft', cursor: 5 }), key({ name: 'escape' }));
    expect(first.action).toEqual({ type: 'none' });
    expect(first.state.buffer).toBe('');
    expect(first.state.escapePrimed).toBe(true);
    // Second consecutive ESC → rewind, and priming is consumed.
    const second = reduceKey(first.state, key({ name: 'escape' }));
    expect(second.action).toEqual({ type: 'rewind' });
    expect(second.state.escapePrimed).toBe(false);
  });

  it('Esc-Esc requires CONSECUTIVE escapes: any key between clears the priming', () => {
    const primed = reduceKey(prompt(), key({ name: 'escape' })).state;
    expect(primed.escapePrimed).toBe(true);
    // A printable key between the two escapes clears priming…
    const typed = reduceKey(primed, key({ name: 'x', sequence: 'x' }));
    expect(typed.state.escapePrimed).toBe(false);
    // …so the next ESC is a fresh FIRST press (clear + re-prime), not a rewind.
    const next = reduceKey(typed.state, key({ name: 'escape' }));
    expect(next.action).toEqual({ type: 'none' });
    expect(next.state.escapePrimed).toBe(true);
  });

  it('ESC never primes/rewinds on a mid-turn confirm (mode === turn)', () => {
    // A confirm mid-turn is awaiting with mode 'turn': ESC clears, never primes.
    const confirm = prompt({ buffer: 'y', cursor: 1, mode: 'turn' });
    const first = reduceKey(confirm, key({ name: 'escape' }));
    expect(first.action).toEqual({ type: 'none' });
    expect(first.state.escapePrimed).toBe(false);
    // Even a forced-primed turn-mode state does not rewind (gated on mode prompt).
    const second = reduceKey({ ...confirm, escapePrimed: true }, key({ name: 'escape' }));
    expect(second.action).toEqual({ type: 'none' });
  });

  it('while NOT awaiting, ordinary keys are ignored (no queue yet in Slice 1)', () => {
    const turn = { ...initialRawState(), mode: 'turn' as const, awaiting: false };
    const r = reduceKey(turn, key({ name: 'a', sequence: 'a' }));
    expect(r.state.buffer).toBe('');
    expect(r.action).toEqual({ type: 'none' });
  });

  it('inserts multi-codepoint printable sequences (emoji / pasted ASCII), rejects control runs', () => {
    // pasted ASCII run
    const paste = reduceKey(prompt(), key({ sequence: 'abc' })).state;
    expect(paste.buffer).toBe('abc');
    expect(paste.cursor).toBe(3);
    // emoji (2 UTF-16 units)
    const emoji = reduceKey(prompt(), key({ sequence: '😀' })).state;
    expect(emoji.buffer).toBe('😀');
    expect(emoji.cursor).toBe(2);
    // a sequence containing a control char (newline) is NOT inserted
    expect(reduceKey(prompt(), key({ sequence: 'a\nb' })).action).toEqual({ type: 'none' });
  });
});

describe('ghost-text (instant + reducer + render)', () => {
  it('instantGhost completes a partial slash command (first match), else nothing', () => {
    expect(instantGhost('/re', ['replay', 'review'])).toBe('play');
    expect(instantGhost('/replay', ['replay', 'review'])).toBe(''); // already complete
    expect(instantGhost('/zz', ['replay'])).toBe(''); // no match
    expect(instantGhost('/', ['replay'])).toBe(''); // nothing typed yet
    expect(instantGhost('review the code', ['replay'])).toBe(''); // not a bare /command
  });

  it('Tab accepts the ghost into the buffer', () => {
    const s = prompt({ buffer: '/re', cursor: 3, ghost: 'play' });
    const r = reduceKey(s, key({ name: 'tab' }));
    expect(r.state.buffer).toBe('/replay');
    expect(r.state.cursor).toBe(7);
    expect(r.state.ghost).toBe('');
  });

  it('→ at the end of the buffer accepts the ghost; mid-buffer it just moves', () => {
    const atEnd = reduceKey(prompt({ buffer: 'rea', cursor: 3, ghost: 'd it' }), key({ name: 'right' }));
    expect(atEnd.state.buffer).toBe('read it');
    const mid = reduceKey(prompt({ buffer: 'abc', cursor: 1, ghost: 'X' }), key({ name: 'right' }));
    expect(mid.state.buffer).toBe('abc');
    expect(mid.state.cursor).toBe(2);
  });

  it('an edit clears the ghost (the shell recomputes it)', () => {
    expect(reduceKey(prompt({ buffer: 'a', cursor: 1, ghost: 'bc' }), key({ name: 'x', sequence: 'x' })).state.ghost).toBe('');
    expect(reduceKey(prompt({ buffer: 'a', cursor: 1, ghost: 'bc' }), key({ name: 'backspace' })).state.ghost).toBe('');
  });

  it('renderInput draws the ghost and counts it in the cursor-back', () => {
    const out = renderInput(prompt({ buffer: '/re', cursor: 3, ghost: 'play' }), '> ');
    expect(out).toContain('/re');
    expect(out).toContain('play');
    expect(out).toContain('[4D'); // cursor back over the 4-char ghost
  });
});

describe('renderInput', () => {
  it('clears the line, writes prompt+buffer, and moves the cursor back', () => {
    const s = prompt({ buffer: 'abcd', cursor: 2 });
    const out = renderInput(s, '> ');
    // contains the clear-line, prompt, buffer
    expect(out).toContain('[2K');
    expect(out).toContain('> abcd');
    // cursor moved back over the 2 chars after the insertion point
    expect(out).toContain('[2D');
  });

  it('omits the cursor-back move when the cursor is at the end', () => {
    const out = renderInput(prompt({ buffer: 'ab', cursor: 2 }), '> ');
    expect(out).toContain('> ab');
    expect(out).not.toMatch(/\[\d+D/);
  });
});

// --- shell lifecycle (fake TTY) ---------------------------------------------

function fakeTty(): PassThrough & { isTTY: boolean; rawCalls: boolean[]; setRawMode: (v: boolean) => unknown } {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; rawCalls: boolean[]; setRawMode: (v: boolean) => unknown };
  s.isTTY = true;
  s.rawCalls = [];
  s.setRawMode = (v: boolean): unknown => {
    s.rawCalls.push(v);
    return s;
  };
  return s;
}

function memOut(): { write: (s: string) => boolean; text: string } {
  const chunks: string[] = [];
  return {
    write: (s: string): boolean => {
      chunks.push(s);
      return true;
    },
    get text(): string {
      return chunks.join('');
    },
  };
}

describe('raw editor shell (fake TTY)', () => {
  const opened: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const e of opened.splice(0)) {
      e.close();
    }
  });

  it('enables raw mode, assembles a line on Enter, and restores cooked on close', async () => {
    const stdin = fakeTty();
    const out = memOut();
    const ui = new Ui({ stdin, stdout: out as unknown as NodeJS.WritableStream, interactive: true });
    const editor = ui.openLineEditor();
    opened.push(editor);

    const pending = editor.question('› ');
    expect(stdin.rawCalls).toContain(true); // raw enabled on first question

    stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
    stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
    stdin.emit('keypress', '\r', { name: 'return' });
    await expect(pending).resolves.toBe('hi');

    editor.close();
    expect(stdin.rawCalls).toContain(false); // cooked restored on close
  });

  it('a throwing handler triggers failSafe: cooked restored + the pending read resolves (no hang)', async () => {
    const stdin = fakeTty();
    const out = memOut();
    const ui = new Ui({ stdin, stdout: out as unknown as NodeJS.WritableStream, interactive: true });
    const editor = ui.openLineEditor();
    opened.push(editor);

    const pending = editor.question('› '); // awaiting; a waiter is pending
    editor.onSigint(() => {
      throw new Error('boom');
    });
    stdin.emit('keypress', '', { ctrl: true, name: 'c' }); // sigint → handler throws → failSafe

    await expect(pending).resolves.toBeNull(); // degraded gracefully, not hung
    expect(stdin.rawCalls).toContain(false); // cooked mode restored
  });

  it('renders an instant slash-command ghost and accepts it with Tab', async () => {
    const stdin = fakeTty();
    const out = memOut();
    const ui = new Ui({ stdin, stdout: out as unknown as NodeJS.WritableStream, interactive: true });
    const editor = ui.openLineEditor({ ghostCommands: ['replay', 'review'] });
    opened.push(editor);

    const pending = editor.question('› ');
    stdin.emit('keypress', '/', { sequence: '/' });
    stdin.emit('keypress', 'r', { name: 'r', sequence: 'r' });
    stdin.emit('keypress', 'e', { name: 'e', sequence: 'e' });
    expect(out.text).toContain('play'); // ghost for "/re" → replay

    stdin.emit('keypress', '\t', { name: 'tab' }); // accept → "/replay"
    stdin.emit('keypress', '\r', { name: 'return' });
    await expect(pending).resolves.toBe('/replay');
  });

  it('shows a model-ghost suggestion after the debounce, when there is no instant ghost', async () => {
    vi.useFakeTimers();
    try {
      const stdin = fakeTty();
      const out = memOut();
      const suggest = vi.fn(async () => 'the payment module');
      const ui = new Ui({ stdin, stdout: out as unknown as NodeJS.WritableStream, interactive: true });
      const editor = ui.openLineEditor({ suggest });
      opened.push(editor);

      void editor.question('› ');
      stdin.emit('keypress', 'r', { name: 'r', sequence: 'r' });
      stdin.emit('keypress', 'e', { name: 'e', sequence: 'e' }); // "re" — not a slash, so no instant ghost
      await vi.advanceTimersByTimeAsync(320); // fire the debounced suggest + resolve it

      expect(suggest).toHaveBeenCalled();
      expect(out.text).toContain('the payment module');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Esc-Esc at the prompt resolves the read with the rewind sentinel', async () => {
    const stdin = fakeTty();
    const out = memOut();
    const ui = new Ui({ stdin, stdout: out as unknown as NodeJS.WritableStream, interactive: true });
    const editor = ui.openLineEditor();
    opened.push(editor);

    const pending = editor.question('› '); // a live prompt is awaiting input
    stdin.emit('keypress', '', { name: 'escape' }); // first ESC → clears + primes
    stdin.emit('keypress', '', { name: 'escape' }); // second ESC → rewind
    await expect(pending).resolves.toBe(REWIND_SENTINEL);
  });

  it('routes ESC during a turn to the onEscape handler', () => {
    const stdin = fakeTty();
    const out = memOut();
    const ui = new Ui({ stdin, stdout: out as unknown as NodeJS.WritableStream, interactive: true });
    const editor = ui.openLineEditor();
    opened.push(editor);

    void editor.question('› '); // enable raw + a live prompt
    let escaped = false;
    editor.onEscape(() => {
      escaped = true;
    });
    editor.setTurnActive(true); // a turn is now running (no reader pending after submit…)
    // Simulate: the prompt's reader is still awaiting, so first SUBMIT it, then ESC mid-turn.
    stdin.emit('keypress', '\r', { name: 'return' }); // submit the (empty) prompt → awaiting=false
    stdin.emit('keypress', '', { name: 'escape' }); // ESC mid-turn → abort
    expect(escaped).toBe(true);
  });
});
