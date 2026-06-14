import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { parseInteractiveArgs } from './repl';
import { buildProgram } from '../program';
import { Writable } from 'node:stream';
import { Ui } from '../ui';

class Sink extends Writable {
  data = '';
  override _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.data += String(chunk);
    callback();
  }
}

describe('parseInteractiveArgs (no-arg interactive path)', () => {
  const argv = (...rest: string[]): string[] => ['node', 'excalibur', ...rest];

  it('returns empty options for no args (the bare interactive path)', () => {
    expect(parseInteractiveArgs(argv())).toEqual({});
  });

  it('parses --continue / -c', () => {
    expect(parseInteractiveArgs(argv('--continue'))).toEqual({ continue: true });
    expect(parseInteractiveArgs(argv('-c'))).toEqual({ continue: true });
  });

  it('parses --resume <id> and --resume=<id>', () => {
    expect(parseInteractiveArgs(argv('--resume', 'sess_20260101_000000'))).toEqual({
      resume: 'sess_20260101_000000',
    });
    expect(parseInteractiveArgs(argv('--resume=sess_20260101_000000'))).toEqual({
      resume: 'sess_20260101_000000',
    });
  });

  it('defers to Commander (null) for any subcommand or unknown flag', () => {
    expect(parseInteractiveArgs(argv('run', 'a task'))).toBeNull();
    expect(parseInteractiveArgs(argv('ask', 'a question'))).toBeNull();
    expect(parseInteractiveArgs(argv('--version'))).toBeNull();
    expect(parseInteractiveArgs(argv('--resume'))).toBeNull(); // malformed
  });
});

describe('non-TTY + no args still shows Commander help (entry guard)', () => {
  it('prints the usage/commands help when no subcommand is given', async () => {
    // This mirrors the non-TTY no-arg path in main.ts: the program is parsed
    // and Commander emits help (then throws commander.help via exitOverride).
    const out = new Sink();
    const ui = new Ui({ stdout: out, stderr: out, interactive: false });
    const program = buildProgram({ ui, cwd: () => '/tmp' });
    await expect(program.parseAsync(['node', 'excalibur'])).rejects.toBeInstanceOf(CommanderError);
    expect(out.data).toContain('Usage:');
    expect(out.data).toContain('Commands:');
    // A real subcommand is still listed in the help (no-arg help is intact).
    expect(out.data).toContain('run');
    expect(out.data).toContain('ask');
  });
});
