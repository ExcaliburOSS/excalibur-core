import * as readline from 'node:readline';
import pc from 'picocolors';

/**
 * The single output module of the Excalibur CLI (Build Contract §4.9).
 *
 * Every byte the CLI prints goes through a `Ui` instance: commands never
 * touch `console` or `process.stdout` directly. Colors come from picocolors,
 * which honors `NO_COLOR` / `FORCE_COLOR` automatically. Prompts use
 * `node:readline` and are ALWAYS skippable: `--yes` (or a non-interactive
 * stdin) resolves every prompt to its safe default.
 */

export interface UiOptions {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  /** Force prompt interactivity on/off (defaults to `stdin.isTTY`). */
  interactive?: boolean;
}

export interface AskOptions {
  /** Skip the prompt and take the default (the `--yes` flag). */
  yes?: boolean;
  /** Value returned when the prompt is skipped or left empty. */
  defaultAnswer?: string;
}

export interface ConfirmOptions {
  /** Skip the prompt and take the default (the `--yes` flag). */
  yes?: boolean;
  /**
   * The safe default (onboarding spec §5): `true` renders `[Y/n]`,
   * `false` renders `[y/N]`. Risky actions must default to `false`.
   */
  defaultYes?: boolean;
}

export interface SelectChoice {
  label: string;
  /** Extra hint rendered dim after the label. */
  hint?: string;
}

export interface SelectOptions {
  yes?: boolean;
  /** Zero-based index returned when the prompt is skipped or left empty. */
  defaultIndex?: number;
}

function hasTty(stream: NodeJS.ReadableStream): boolean {
  return (stream as NodeJS.ReadStream).isTTY === true;
}

export class Ui {
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;
  private readonly stdin: NodeJS.ReadableStream;
  private readonly interactive: boolean;

  constructor(options: UiOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.stdin = options.stdin ?? process.stdin;
    this.interactive = options.interactive ?? hasTty(this.stdin);
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  /** Plain line to stdout. */
  write(text = ''): void {
    this.stdout.write(`${text}\n`);
  }

  /** Raw text to stdout (no trailing newline). */
  writeRaw(text: string): void {
    this.stdout.write(text);
  }

  /** Streams a model output chunk verbatim (no added newline). */
  streamChunk(text: string): void {
    this.writeRaw(text);
  }

  heading(text: string): void {
    this.write(pc.bold(text));
  }

  info(text: string): void {
    this.write(pc.dim(text));
  }

  success(text: string): void {
    this.write(`${pc.green('✓')} ${text}`);
  }

  warn(text: string): void {
    this.write(`${pc.yellow('⚠')} ${pc.yellow(text)}`);
  }

  /** Error line to stderr. */
  error(text: string): void {
    this.stderr.write(`${pc.red('✗')} ${pc.red(text)}\n`);
  }

  /** Machine-readable output for `--json` flags. */
  json(value: unknown): void {
    this.write(JSON.stringify(value, null, 2));
  }

  /** Simple aligned table; headers render bold. */
  table(headers: string[], rows: string[][]): void {
    const widths = headers.map((header, column) =>
      Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
    );
    const render = (cells: string[]): string =>
      cells.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join('  ');
    this.write(pc.bold(render(headers)));
    for (const row of rows) {
      this.write(render(row));
    }
  }

  /** Free-form question; skipped prompts return the default answer. */
  async ask(question: string, options: AskOptions = {}): Promise<string> {
    const defaultAnswer = options.defaultAnswer ?? '';
    if (options.yes === true || !this.interactive) {
      return defaultAnswer;
    }
    const answer = await this.readLine(`${question} `);
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : defaultAnswer;
  }

  /** Yes/no confirmation; renders `[Y/n]` or `[y/N]` per the safe default. */
  async confirm(question: string, options: ConfirmOptions = {}): Promise<boolean> {
    const defaultYes = options.defaultYes ?? false;
    if (options.yes === true || !this.interactive) {
      return defaultYes;
    }
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await this.readLine(`${question} ${suffix} `)).trim().toLowerCase();
    if (answer.length === 0) {
      return defaultYes;
    }
    return answer === 'y' || answer === 'yes';
  }

  /** Numbered chooser; returns the zero-based index of the selection. */
  async select(question: string, choices: SelectChoice[], options: SelectOptions = {}): Promise<number> {
    const defaultIndex = options.defaultIndex ?? 0;
    this.write(question);
    choices.forEach((choice, index) => {
      const marker = index === defaultIndex ? pc.cyan('→') : ' ';
      const hint = choice.hint !== undefined ? ` ${pc.dim(choice.hint)}` : '';
      this.write(`${marker} ${index + 1}. ${choice.label}${hint}`);
    });
    if (options.yes === true || !this.interactive) {
      return defaultIndex;
    }
    const answer = (await this.readLine(`Choose [${defaultIndex + 1}]: `)).trim();
    if (answer.length === 0) {
      return defaultIndex;
    }
    const parsed = Number.parseInt(answer, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > choices.length) {
      return defaultIndex;
    }
    return parsed - 1;
  }

  private readLine(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: this.stdin, output: this.stdout });
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}

/** Default Ui bound to the real process streams. */
export function createUi(options: UiOptions = {}): Ui {
  return new Ui(options);
}
