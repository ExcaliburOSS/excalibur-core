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
    await expect(ui.ask('Question?', { yes: true, defaultAnswer: 'fallback' })).resolves.toBe(
      'fallback',
    );
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

  it('confirmTool is three-way: yes / no / auto ("a" = Auto mode)', async () => {
    await expect(makeUi('a\n').ui.confirmTool('Allow?')).resolves.toBe('auto');
    await expect(makeUi('always\n').ui.confirmTool('Allow?')).resolves.toBe('auto');
    await expect(makeUi('siempre\n').ui.confirmTool('Allow?')).resolves.toBe('auto');
    await expect(makeUi('y\n').ui.confirmTool('Allow?')).resolves.toBe('yes');
    await expect(makeUi('n\n').ui.confirmTool('Allow?')).resolves.toBe('no');
  });

  it('confirmTool resolves to the default (never "auto") when skipped/non-interactive', async () => {
    const { ui } = makeUi();
    await expect(ui.confirmTool('Allow?', { defaultYes: false })).resolves.toBe('no');
    await expect(ui.confirmTool('Allow?', { defaultYes: true })).resolves.toBe('yes');
    // empty line at an interactive prompt also falls back to the default
    await expect(makeUi('\n').ui.confirmTool('Allow?', { defaultYes: false })).resolves.toBe('no');
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
    ui.table(
      ['ID', 'NAME'],
      [
        ['a', 'Alpha'],
        ['longer-id', 'B'],
      ],
    );
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

  it('the slash-menu repaint never erases content above the prompt', async () => {
    // A tiny terminal model: apply the editor's raw bytes to a grid and check the
    // lines printed BEFORE the prompt survive. The buggy menu repaint walked the
    // cursor up by the FULL block height (input + menu) and erased the welcome on
    // every keystroke; this pins it to never reach above the input's first row.
    const applyVT = (bytes: string, rows = 40, cols = 160): string[] => {
      const grid = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
      let r = 0;
      let c = 0;
      for (let i = 0; i < bytes.length; ) {
        const ch = bytes[i] as string;
        if (ch === '\x1b' && bytes[i + 1] === '[') {
          let j = i + 2;
          let p = '';
          while (j < bytes.length && /[0-9;]/.test(bytes[j] as string)) {
            p += bytes[j];
            j += 1;
          }
          const cmd = bytes[j] as string;
          const n = Number.parseInt(p.split(';')[0] ?? '', 10);
          const amount = Number.isNaN(n) ? (cmd === 'J' || cmd === 'K' ? 0 : 1) : n;
          if (cmd === 'A') r = Math.max(0, r - amount);
          else if (cmd === 'B') r = Math.min(rows - 1, r + amount);
          else if (cmd === 'C') c = Math.min(cols - 1, c + amount);
          else if (cmd === 'D') c = Math.max(0, c - amount);
          else if (cmd === 'J' && amount === 0) {
            for (let cc = c; cc < cols; cc += 1) grid[r]![cc] = ' ';
            for (let rr = r + 1; rr < rows; rr += 1)
              for (let cc = 0; cc < cols; cc += 1) grid[rr]![cc] = ' ';
          } else if (cmd === 'K') {
            const from = amount === 2 ? 0 : c;
            for (let cc = from; cc < cols; cc += 1) grid[r]![cc] = ' ';
          }
          i = j + 1;
          continue;
        }
        if (ch === '\n') {
          r = Math.min(rows - 1, r + 1);
          c = 0;
          i += 1;
          continue;
        }
        if (ch === '\r') {
          c = 0;
          i += 1;
          continue;
        }
        grid[r]![c] = ch;
        c += 1;
        if (c >= cols) {
          c = 0;
          r = Math.min(rows - 1, r + 1);
        }
        i += 1;
      }
      return grid.map((row) => row.join('').replace(/\s+$/, ''));
    };

    const out = new Sink();
    const stdin = new PassThrough();
    // Make the stream look like a TTY so the editor takes the raw per-keypress
    // paint path — the slash menu only renders on a real terminal.
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    (stdin as unknown as { setRawMode: (m: boolean) => void }).setRawMode = () => undefined;
    const ui = new Ui({ stdout: out, stderr: new Sink(), stdin, interactive: true });
    ui.write('WELCOME-ALPHA');
    ui.write('WELCOME-BETA');
    ui.write('WELCOME-GAMMA');
    const editor = ui.openLineEditor({
      commands: [
        { name: 'plan', description: 'plan a build' },
        { name: 'play', description: 'play something' },
        { name: 'patch', description: 'apply a patch' },
      ],
    });
    const pending = editor.question('> ');
    for (const chunk of ['/', 'p', 'l', 'a', 'n']) {
      stdin.write(chunk);
      await new Promise((res) => setTimeout(res, 5));
    }

    const screen = applyVT(out.data);
    // The lines above the prompt are untouched by the menu repaint.
    expect(screen.some((l) => l.includes('WELCOME-ALPHA'))).toBe(true);
    expect(screen.some((l) => l.includes('WELCOME-BETA'))).toBe(true);
    expect(screen.some((l) => l.includes('WELCOME-GAMMA'))).toBe(true);
    // The prompt still shows what was typed.
    expect(screen.some((l) => l.includes('> /plan'))).toBe(true);

    stdin.write('\r'); // Enter (raw mode) submits
    await pending;
    editor.close();
  });
});
