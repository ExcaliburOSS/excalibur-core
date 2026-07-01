import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Ui, type LineEditor } from './ui';

/**
 * RUN-FIX-25 — the raw line editor must distinguish a DELIBERATE close (double-Ctrl-C /
 * teardown, via close()) from a null produced by a bare Ctrl-D or a SPURIOUS EOF (the
 * Ink-approval → raw-editor stdin handoff after a gated build). The REPL exits on a null read
 * ONLY when `wasClosedByUser()` is true; otherwise it `reopen()`s and re-prompts, so the shell
 * never exits on its own. This locks that contract on the real editor without a pty.
 */

/** A minimal fake TTY input the raw editor can drive keypress events through. */
function fakeTtyInput(): EventEmitter & {
  isTTY: boolean;
  setRawMode: () => unknown;
  resume: () => void;
  pause: () => void;
} {
  const e = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode: () => unknown;
    resume: () => void;
    pause: () => void;
  };
  e.isTTY = true;
  e.setRawMode = () => e;
  e.resume = () => {};
  e.pause = () => {};
  return e;
}

/** A fake TTY output that swallows every ANSI write. */
function fakeTtyOutput(): EventEmitter & {
  isTTY: boolean;
  columns: number;
  rows: number;
  write: (s: string) => boolean;
} {
  const e = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    columns: number;
    rows: number;
    write: (s: string) => boolean;
  };
  e.isTTY = true;
  e.columns = 80;
  e.rows = 24;
  e.write = () => true;
  return e;
}

function makeRawEditor(input: EventEmitter, output: EventEmitter): LineEditor {
  const ui = new Ui({
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream,
    interactive: true,
  });
  // openLineEditor picks the raw editor on a TTY stdin.
  return ui.openLineEditor();
}

describe('RUN-FIX-25 — raw editor close vs spurious/EOF null', () => {
  it('a fresh editor is not user-closed', () => {
    const editor = makeRawEditor(fakeTtyInput(), fakeTtyOutput());
    expect(editor.wasClosedByUser()).toBe(false);
    editor.close();
  });

  it('a bare Ctrl-D resolves null but is NOT a user close, and reopen re-arms for the next read', async () => {
    const input = fakeTtyInput();
    const editor = makeRawEditor(input, fakeTtyOutput());

    // First read: send Ctrl-D on an empty buffer → the editor resolves null (EOF), but this is
    // NOT a deliberate user close.
    const first = editor.question('› ');
    input.emit('keypress', '', { name: 'd', ctrl: true });
    await expect(first).resolves.toBeNull();
    expect(editor.wasClosedByUser()).toBe(false);

    // The REPL would now reopen() + re-prompt instead of exiting. After reopen the editor reads
    // a real line again (the shell survived the spurious/EOF null).
    editor.reopen();
    const second = editor.question('› ');
    for (const ch of 'hola') {
      // A printable char is read from key.sequence (isPrintableSeq).
      input.emit('keypress', ch, { name: ch, sequence: ch });
    }
    input.emit('keypress', '\r', { name: 'return', sequence: '\r' });
    await expect(second).resolves.toBe('hola');

    editor.close();
  });

  it('close() IS a user close — the REPL may exit on the resulting null', () => {
    const editor = makeRawEditor(fakeTtyInput(), fakeTtyOutput());
    editor.close();
    expect(editor.wasClosedByUser()).toBe(true);
    // reopen refuses after a deliberate close.
    editor.reopen();
    expect(editor.wasClosedByUser()).toBe(true);
  });
});
