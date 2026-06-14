import { PassThrough, Writable } from 'node:stream';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Ui } from './ui';

class Sink extends Writable {
  data = '';
  override _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.data += String(chunk);
    callback();
  }
}

function makeUi(input?: string): { ui: Ui; out: Sink; err: Sink } {
  const out = new Sink();
  const err = new Sink();
  const stdin = input !== undefined ? Readable.from([input]) : Readable.from([]);
  const ui = new Ui({ stdout: out, stderr: err, stdin, interactive: input !== undefined });
  return { ui, out, err };
}

describe('Ui prompts are always skippable (Build Contract §4.9)', () => {
  it('ask returns the default with --yes', async () => {
    const { ui } = makeUi('typed answer\n');
    await expect(ui.ask('Question?', { yes: true, defaultAnswer: 'fallback' })).resolves.toBe('fallback');
  });

  it('ask returns the default when stdin is not interactive', async () => {
    const { ui } = makeUi();
    await expect(ui.ask('Question?', { defaultAnswer: 'quiet' })).resolves.toBe('quiet');
  });

  it('ask reads the typed answer when interactive', async () => {
    const { ui } = makeUi('typed answer\n');
    await expect(ui.ask('Question?')).resolves.toBe('typed answer');
  });

  it('confirm keeps the SAFE default when skipped ([y/N] stays no)', async () => {
    const { ui } = makeUi();
    await expect(ui.confirm('Apply patch?', { yes: true, defaultYes: false })).resolves.toBe(false);
    await expect(ui.confirm('Continue?', { yes: true, defaultYes: true })).resolves.toBe(true);
  });

  it('confirm parses interactive yes/no answers', async () => {
    const yes = makeUi('y\n');
    await expect(yes.ui.confirm('Apply?', { defaultYes: false })).resolves.toBe(true);
    const no = makeUi('n\n');
    await expect(no.ui.confirm('Apply?', { defaultYes: true })).resolves.toBe(false);
  });

  it('select returns the default index when skipped', async () => {
    const { ui } = makeUi();
    const index = await ui.select('Pick:', [{ label: 'a' }, { label: 'b' }, { label: 'c' }], {
      yes: true,
      defaultIndex: 2,
    });
    expect(index).toBe(2);
  });

  it('select parses a numeric interactive choice', async () => {
    const { ui } = makeUi('2\n');
    const index = await ui.select('Pick:', [{ label: 'a' }, { label: 'b' }], { defaultIndex: 0 });
    expect(index).toBe(1);
  });
});

describe('Ui output', () => {
  it('writes errors to stderr and regular output to stdout', () => {
    const { ui, out, err } = makeUi();
    ui.write('hello');
    ui.error('boom');
    expect(out.data).toContain('hello');
    expect(err.data).toContain('boom');
    expect(out.data).not.toContain('boom');
  });

  it('renders aligned tables with headers', () => {
    const { ui, out } = makeUi();
    ui.table(['ID', 'NAME'], [['a', 'Alpha'], ['longer-id', 'B']]);
    const lines = out.data.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('a');
    expect(lines[2]).toContain('longer-id');
  });

  it('prints machine-readable JSON', () => {
    const { ui, out } = makeUi();
    ui.json({ ok: true, items: [1, 2] });
    expect(JSON.parse(out.data)).toEqual({ ok: true, items: [1, 2] });
  });
});

describe('Ui.openLineEditor (M-Shell Slice A)', () => {
  it('reads successive lines from a single persistent interface', async () => {
    const out = new Sink();
    const stdin = new PassThrough();
    const ui = new Ui({ stdout: out, stderr: new Sink(), stdin, interactive: true });
    const editor = ui.openLineEditor();

    const first = editor.question('> ');
    stdin.write('hello world\n');
    expect(await first).toBe('hello world');

    const second = editor.question('> ');
    stdin.write('second line\n');
    expect(await second).toBe('second line');

    editor.close();
  });

  it('resolves null on EOF (Ctrl-D / stream end)', async () => {
    const stdin = new PassThrough();
    const ui = new Ui({ stdout: new Sink(), stderr: new Sink(), stdin, interactive: true });
    const editor = ui.openLineEditor();
    const pending = editor.question('> ');
    stdin.end();
    expect(await pending).toBeNull();
  });

  it('seeds the history without breaking line reads', async () => {
    // The seeded prompt history is consumed by readline at construction time
    // (UP/DOWN native); seeding must not disturb normal line reading.
    const stdin = new PassThrough();
    const ui = new Ui({ stdout: new Sink(), stderr: new Sink(), stdin, interactive: true });
    const editor = ui.openLineEditor({ history: ['newest prompt', 'older prompt'] });
    const pending = editor.question('> ');
    stdin.write('typed now\n');
    expect(await pending).toBe('typed now');
    editor.close();
  });

  it('exposes a SIGINT subscription that can be unsubscribed', () => {
    // Real Ctrl-C only fires on a raw TTY; here we just assert the wiring
    // contract — `onSigint` registers a handler and returns an unsubscribe fn.
    const stdin = new PassThrough();
    const ui = new Ui({ stdout: new Sink(), stderr: new Sink(), stdin, interactive: true });
    const editor = ui.openLineEditor();
    const off = editor.onSigint(() => undefined);
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
    editor.close();
  });
});
