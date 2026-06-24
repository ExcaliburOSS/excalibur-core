import * as readline from 'node:readline';
import pc from 'picocolors';
import { Spinner, isTtyStream } from './lib/spinner';
import {
  initialRawState,
  instantGhost,
  reduceKey,
  renderInput,
  type ParsedKey,
  type RawInputState,
} from './lib/raw-input';
import {
  computeWindow,
  reduceSelectKey,
  renderChoiceLine,
  type SelectState,
} from './lib/select-input';
import type { SelectKeymap } from './lib/keymap';

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

/**
 * Out-of-band line value the raw editor resolves a pending prompt with when the
 * user presses Esc-Esc — the REPL recognizes it and opens the rewind
 * time-machine instead of treating it as typed text. It carries a NUL byte, so
 * it is UNFORGEABLE from typed/pasted input (the reducer rejects control bytes).
 */
export const REWIND_SENTINEL = `${String.fromCharCode(0)}__excalibur_rewind__`;
/** Resolves a pending read when ↓ opens the Session Log (NUL-prefixed → never a real line). */
export const LOG_SENTINEL = `${String.fromCharCode(0)}__excalibur_log__`;

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
  /**
   * Optional section label. Consecutive choices sharing a group get a single dim
   * header above them in the interactive picker (shown only when not filtering).
   */
  group?: string;
}

export interface SelectOptions {
  yes?: boolean;
  /** Zero-based index returned when the prompt is skipped or left empty. */
  defaultIndex?: number;
  /**
   * Dim navigation hint shown under the question in the interactive arrow-key
   * chooser (already translated by the caller). Defaults to a neutral
   * symbol-based hint; ignored by the numbered fallback.
   */
  navHint?: string;
  /**
   * Effective picker keybindings (P1.13b). Defaults to the built-in arrow/jk set;
   * callers with config pass `resolveSelectKeymap(config.keybindings?.select)` to
   * honor user-rebound keys. Ignored by the numbered fallback.
   */
  keymap?: SelectKeymap;
}

export interface LineEditorOptions {
  /**
   * Seed history (newest first), as `readline` expects. The persistent
   * interface exposes it through UP/DOWN natively. Pass the per-repo prompt
   * history from `SessionStore.loadPromptHistory()` reversed.
   */
  history?: string[];
  /** Optional readline completer for tab-completion (slash commands, …). */
  completer?: readline.Completer;
  /**
   * Slash-command names (no leading `/`) for the raw editor's INSTANT ghost-text
   * completion (e.g. typing `/re` ghosts `play`). Ignored by the queue editor.
   */
  ghostCommands?: string[];
  /**
   * Async model-powered ghost suggester (raw editor only): given the current
   * buffer, returns a dim completion to show (or null). Debounced, cancelable
   * per keystroke, and only applied if the buffer is unchanged. The caller is
   * responsible for redaction + opt-out + cheap-model routing.
   */
  suggest?: (buffer: string, signal: AbortSignal) => Promise<string | null>;
}

/**
 * A persistent line editor over a single long-lived `readline.Interface`
 * (M-Shell Slice A). Unlike `Ui.ask`/`confirm`/`select` — which spin up a
 * throwaway interface per call — this keeps ONE interface alive across the
 * whole REPL session so UP/DOWN history works natively.
 */
export interface LineEditor {
  /** Prompts and resolves with the typed line (`null` on EOF / Ctrl-D). */
  question(prompt: string): Promise<string | null>;
  /** Registers a SIGINT (Ctrl-C) handler; returns an unsubscribe fn. */
  onSigint(handler: () => void): () => void;
  /**
   * Tells the editor a turn is in flight (`true`) or finished (`false`). The
   * raw-keypress editor uses this to switch modes (ESC cancels a running turn;
   * input typed during one is queued). A no-op on the line/queue editor.
   */
  setTurnActive(active: boolean): void;
  /**
   * Registers an ESC handler (raw editor: ESC during a turn cancels it). Returns
   * an unsubscribe fn. A no-op (returning a no-op unsubscribe) on the line editor.
   */
  onEscape(handler: () => void): () => void;
  /** Closes the underlying interface. */
  close(): void;
}

function hasTty(stream: NodeJS.ReadableStream): boolean {
  return (stream as NodeJS.ReadStream).isTTY === true;
}

export class Ui {
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;
  private readonly stdin: NodeJS.ReadableStream;
  private readonly interactive: boolean;
  /**
   * The active persistent line reader (the REPL editor), when one is open.
   * While set, the per-call prompts (`ask`/`confirm`/`select`) read their
   * lines through it instead of spinning up a throwaway readline interface, so
   * a SINGLE readline owns stdin for the whole session — approvals and history
   * coexist without two interfaces fighting over the input stream.
   */
  // The open editor's line reader. It takes the prompt so the reader OWNS prompt
  // display: the queue editor echoes via the terminal, but the raw editor must
  // re-render the prompt+buffer on every keystroke (raw mode has no echo).
  private activeReader: ((prompt: string) => Promise<string | null>) | null = null;
  /**
   * Suspend/resume the persistent raw editor's stdin ownership (raw mode +
   * keypress listener) so another consumer — the Ink live view during a turn —
   * can own stdin, then hand it back. Registered by the raw editor; null with
   * the queue editor (non-TTY), where both are no-ops.
   */
  private suspendEditor: (() => void) | null = null;
  private resumeEditor: (() => void) | null = null;
  /**
   * True while a per-call sub-prompt (`ask`/`confirm`/`select`/`confirmTool`)
   * is reading through the shared raw editor. The rewind (Esc-Esc) and Session
   * Log (↓) gestures belong to the MAIN session line only — they must never
   * resolve a mid-turn confirmation/question with a sentinel.
   */
  private inSubPrompt = false;

  constructor(options: UiOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.stdin = options.stdin ?? process.stdin;
    this.interactive = options.interactive ?? hasTty(this.stdin);
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  /**
   * Whether STDOUT is a real TTY (distinct from {@link isInteractive}, which
   * tracks STDIN for prompts). The live in-place rail redraw needs this: a
   * piped/CI stdout must fall back to streamed lines.
   */
  isOutputTty(): boolean {
    return isTtyStream(this.stdout);
  }

  /**
   * Releases the persistent raw editor's hold on stdin (raw mode + keypress
   * listener) so the Ink live view can own input for a turn. No-op without a raw
   * editor (queue editor / non-TTY). Pair with {@link resumeInput}.
   */
  suspendInput(): void {
    this.suspendEditor?.();
  }

  /** Re-arms the raw editor's stdin ownership after an Ink turn. */
  resumeInput(): void {
    this.resumeEditor?.();
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

  /**
   * A transient "thinking/working" indicator bound to this Ui's stdout. It only
   * animates on a real TTY (piped/CI/test streams get a no-op), so callers can
   * always create + drive it without guarding for non-interactive output.
   */
  createSpinner(options: { unicode?: boolean } = {}): Spinner {
    return new Spinner(this.stdout, {
      enabled: isTtyStream(this.stdout),
      ...(options.unicode !== undefined ? { unicode: options.unicode } : {}),
    });
  }

  heading(text: string): void {
    this.write(pc.bold(text));
  }

  /**
   * Styles a prompt's question in intense blue + bold — the shared accent for
   * every interactive question (select/ask/confirm). picocolors auto-disables
   * color on non-TTY output (NO_COLOR / pipes / tests), so this is a no-op there
   * and scripted-stdin tests stay byte-for-byte unchanged.
   */
  private formatQuestion(text: string): string {
    return pc.bold(pc.blueBright(text));
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
    const answer = await this.readLine(`${this.formatQuestion(question)} `);
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : defaultAnswer;
  }

  /**
   * Masked free-text prompt for SECRETS (API keys): on a real TTY the typed
   * value is echoed as dots so a pasted key never appears on screen. On any
   * non-TTY stdin/stdout (scripted tests, CI, pipes), `--yes`, or
   * `EXCALIBUR_RAW_INPUT=0`, it falls back to {@link ask} (plain line read), so
   * scripted paths stay deterministic. Returns the typed value, or the default
   * when skipped/empty.
   */
  async askSecret(question: string, options: AskOptions = {}): Promise<string> {
    const defaultAnswer = options.defaultAnswer ?? '';
    if (options.yes === true || !this.interactive) {
      return defaultAnswer;
    }
    const rawAllowed = process.env['EXCALIBUR_RAW_INPUT'] !== '0';
    if (!(hasTty(this.stdin) && this.isOutputTty() && rawAllowed)) {
      return this.ask(question, options); // non-TTY: plain (unmasked) line read
    }
    return this.readSecretRaw(`${this.formatQuestion(question)} `, defaultAnswer);
  }

  /** Raw-mode masked reader backing {@link askSecret} (real TTY only). */
  private readSecretRaw(prompt: string, defaultAnswer: string): Promise<string> {
    const input = this.stdin as NodeJS.ReadStream;
    const out = this.stdout;
    const ESC = String.fromCharCode(27);
    const isPrintable = (seq: string): boolean => {
      for (const ch of seq) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
          return false;
        }
      }
      return true;
    };
    let buffer = '';

    const borrowed = this.suspendEditor !== null;
    if (borrowed) {
      this.suspendInput();
    }
    const render = (): void => {
      out.write(`\r${ESC}[2K${prompt}${pc.dim('•'.repeat(buffer.length))}`);
    };
    const restoreCooked = (): void => {
      try {
        if (input.isTTY === true && typeof input.setRawMode === 'function') {
          input.setRawMode(false);
        }
      } catch {
        // best-effort: never throw while restoring the terminal
      }
    };
    const onTermSignal = (): void => {
      restoreCooked();
      process.exit(143);
    };

    out.write(prompt);
    return new Promise<string>((resolve) => {
      let done = false;
      const finish = (value: string): void => {
        if (done) {
          return;
        }
        done = true;
        input.removeListener('keypress', onKeypress);
        process.removeListener('exit', restoreCooked);
        process.removeListener('SIGTERM', onTermSignal);
        process.removeListener('SIGHUP', onTermSignal);
        restoreCooked();
        if (borrowed) {
          this.resumeInput();
        }
        out.write('\n');
        resolve(value.length > 0 ? value : defaultAnswer);
      };
      const onKeypress = (_str: string | undefined, key: ParsedKey | undefined): void => {
        if (key === undefined) {
          return;
        }
        try {
          if (key.ctrl === true && key.name === 'c') {
            finish('');
            process.kill(process.pid, 'SIGINT');
            return;
          }
          if (key.name === 'return' || key.name === 'enter') {
            finish(buffer);
            return;
          }
          if (key.name === 'backspace') {
            buffer = buffer.slice(0, -1);
            render();
            return;
          }
          if (key.ctrl === true && key.name === 'u') {
            buffer = '';
            render();
            return;
          }
          if (key.ctrl === true || key.meta === true) {
            return;
          }
          if (key.sequence !== undefined && key.sequence.length > 0 && isPrintable(key.sequence)) {
            buffer += key.sequence;
            render();
          }
        } catch {
          finish(buffer);
        }
      };

      readline.emitKeypressEvents(input);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(true);
      }
      input.resume();
      input.on('keypress', onKeypress);
      process.on('exit', restoreCooked);
      process.once('SIGTERM', onTermSignal);
      process.once('SIGHUP', onTermSignal);
    });
  }

  /** Yes/no confirmation; renders `[Y/n]` or `[y/N]` per the safe default. */
  async confirm(question: string, options: ConfirmOptions = {}): Promise<boolean> {
    const defaultYes = options.defaultYes ?? false;
    if (options.yes === true || !this.interactive) {
      return defaultYes;
    }
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await this.readLine(`${this.formatQuestion(question)} ${pc.dim(suffix)} `))
      .trim()
      .toLowerCase();
    if (answer.length === 0) {
      return defaultYes;
    }
    return answer === 'y' || answer === 'yes';
  }

  /**
   * Three-way tool-approval prompt: `[y / N / a]` (a = Auto mode). Returns
   * 'yes', 'no', or 'auto' — "auto" turns on session-wide auto-accept (the
   * caller persists it), so the user approves ONCE and Excalibur never asks
   * again. Non-interactive / `yes` resolves to the default ('yes' when defaultYes).
   */
  async confirmTool(
    question: string,
    options: ConfirmOptions = {},
  ): Promise<'yes' | 'no' | 'auto'> {
    const defaultYes = options.defaultYes ?? false;
    if (options.yes === true || !this.interactive) {
      return defaultYes ? 'yes' : 'no';
    }
    // Three-way: Yes / No / Auto mode. "a" turns on session-wide auto-accept
    // (persisted) so Excalibur stops asking entirely — unifying the per-edit
    // prompt with the `/auto` mode (one concept, not a per-tool allowlist).
    const suffix = defaultYes ? '[Y/n/a]' : '[y/N/a]';
    const answer = (await this.readLine(`${this.formatQuestion(question)} ${pc.dim(suffix)} `))
      .trim()
      .toLowerCase();
    if (answer.length === 0) {
      return defaultYes ? 'yes' : 'no';
    }
    if (answer === 'a' || answer === 'auto' || answer === 'always' || answer === 'siempre') {
      return 'auto';
    }
    return answer === 'y' || answer === 'yes' || answer === 's' || answer === 'si' ? 'yes' : 'no';
  }

  /**
   * Chooser; returns the zero-based index of the selection. On a real TTY this
   * is an INTERACTIVE arrow-key list: ↑/↓ (and j/k) move the highlight live,
   * Enter selects, a digit 1–9 jumps-and-selects, Esc takes the default. On any
   * non-TTY stdin/stdout (scripted tests, CI, pipes), with `--yes`, or with
   * `EXCALIBUR_RAW_INPUT=0`, it falls back to the deterministic numbered chooser
   * (type a number), so every scripted path stays byte-for-byte unchanged.
   */
  async select(
    question: string,
    choices: SelectChoice[],
    options: SelectOptions = {},
  ): Promise<number> {
    const defaultIndex = options.defaultIndex ?? 0;
    const rawAllowed = process.env['EXCALIBUR_RAW_INPUT'] !== '0';
    const useArrows =
      options.yes !== true &&
      this.interactive &&
      hasTty(this.stdin) &&
      this.isOutputTty() &&
      rawAllowed &&
      choices.length > 0;
    if (useArrows) {
      return this.selectInteractive(
        question,
        choices,
        defaultIndex,
        options.navHint,
        options.keymap,
      );
    }
    return this.selectByNumber(question, choices, options, defaultIndex);
  }

  /**
   * The deterministic numbered chooser (non-TTY / `--yes` / scripted stdin): the
   * original behavior — print a numbered list (the default row marked with `→`)
   * and read a typed number. Kept byte-for-byte so every scripted test is stable.
   */
  private async selectByNumber(
    question: string,
    choices: SelectChoice[],
    options: SelectOptions,
    defaultIndex: number,
  ): Promise<number> {
    this.write(this.formatQuestion(question));
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

  /**
   * The interactive arrow-key chooser (real TTY). Renders the question, an
   * optional dim nav hint, and the list; drives Node `keypress` events through
   * the pure {@link reduceSelectKey} reducer, repainting the list block in place
   * on every move. ALWAYS restores cooked mode (close + process exit/signals) so
   * the terminal can never be left in raw mode. If a persistent raw editor owns
   * stdin (e.g. a `/models` prompt mid-REPL), borrow it via suspend/resume.
   */
  private selectInteractive(
    question: string,
    choices: SelectChoice[],
    defaultIndex: number,
    navHint?: string,
    keymap?: SelectKeymap,
  ): Promise<number> {
    const input = this.stdin as NodeJS.ReadStream;
    const out = this.stdout;
    const ESC = String.fromCharCode(27);
    const total = choices.length;
    const safe = (i: number): number => (i < 0 || i >= total ? 0 : i);

    // How many list rows fit: leave room for the question, nav hint, the optional
    // filter line, the two ▲/▼ indicators and up to a few group headers. Clamped
    // to a comfy band so the drawn block can never exceed the viewport.
    const rows = (out as { rows?: number }).rows ?? 24;
    const windowSize = Math.max(4, Math.min(12, rows - 8));

    let state: SelectState = { index: safe(defaultIndex), query: '' };
    // The filtered view = original indices whose label/hint match the query.
    const computeFiltered = (query: string): number[] => {
      if (query.length === 0) {
        return choices.map((_, i) => i);
      }
      const q = query.toLowerCase();
      const out: number[] = [];
      choices.forEach((choice, i) => {
        if (`${choice.label} ${choice.hint ?? ''}`.toLowerCase().includes(q)) {
          out.push(i);
        }
      });
      return out;
    };
    let filtered = computeFiltered('');

    // Borrow stdin from the persistent raw editor when one is open; hand it back
    // when we're done. No-op during onboarding (the editor isn't open yet).
    const borrowed = this.suspendEditor !== null;
    if (borrowed) {
      this.suspendInput();
    }

    // Build the block as an array of lines, then paint it in place — clearing
    // exactly what we drew last time (ESC[J), so a list taller than the viewport
    // can never corrupt the redraw.
    let linesDrawn = 0;
    const block = (): string[] => {
      const lines: string[] = [this.formatQuestion(question)];
      lines.push(pc.dim(navHint ?? '↑/↓ move · type to filter · enter select · esc cancel'));
      if (state.query.length > 0) {
        lines.push(`${pc.dim('filter:')} ${state.query}${pc.dim('▏')}`);
      }
      if (filtered.length === 0) {
        lines.push(pc.dim('  no matches — backspace to edit'));
        return lines;
      }
      const { start, end } = computeWindow(state.index, filtered.length, windowSize);
      if (start > 0) {
        lines.push(pc.dim(`  ▲ ${start} more`));
      }
      let lastGroup: string | undefined;
      for (let i = start; i < end; i += 1) {
        const orig = filtered[i] as number;
        const choice = choices[orig] as SelectChoice;
        // Section headers only when not filtering — a single dim line when the
        // group changes (the first visible row shows its group for context).
        if (state.query.length === 0 && choice.group !== undefined && choice.group !== lastGroup) {
          lines.push(pc.dim(pc.bold(choice.group)));
          lastGroup = choice.group;
        }
        lines.push(renderChoiceLine(choice, i === state.index, orig + 1));
      }
      if (end < filtered.length) {
        lines.push(pc.dim(`  ▼ ${filtered.length - end} more`));
      }
      return lines;
    };
    const draw = (): void => {
      if (linesDrawn > 0) {
        out.write(`${ESC}[${linesDrawn}A`); // back to the first line of the block
      }
      out.write(`\r${ESC}[0J`); // clear from the cursor to end of screen
      const lines = block();
      out.write(`${lines.join('\n')}\n`);
      linesDrawn = lines.length;
    };

    const restoreCooked = (): void => {
      try {
        if (input.isTTY === true && typeof input.setRawMode === 'function') {
          input.setRawMode(false);
        }
      } catch {
        // best-effort: never throw while restoring the terminal
      }
    };
    const onTermSignal = (): void => {
      restoreCooked();
      process.exit(143);
    };

    draw();

    return new Promise<number>((resolve) => {
      let done = false;
      const onKeypress = (_str: string | undefined, key: ParsedKey | undefined): void => {
        if (key === undefined) {
          return;
        }
        try {
          const result = reduceSelectKey(state, key, filtered.length, keymap);
          state = result.state;
          switch (result.action.type) {
            case 'filter':
              filtered = computeFiltered(state.query);
              draw();
              return;
            case 'move':
              draw();
              return;
            case 'submit': {
              const orig = filtered[result.action.index];
              draw(); // paint the final highlight before leaving
              finish(orig ?? safe(defaultIndex));
              return;
            }
            case 'cancel':
              finish(safe(defaultIndex));
              return;
            case 'sigint':
              out.write('\n');
              finish(safe(defaultIndex));
              process.kill(process.pid, 'SIGINT');
              return;
            case 'none':
              return;
          }
        } catch {
          finish(safe(defaultIndex));
        }
      };
      const finish = (index: number): void => {
        if (done) {
          return;
        }
        done = true;
        input.removeListener('keypress', onKeypress);
        process.removeListener('exit', restoreCooked);
        process.removeListener('SIGTERM', onTermSignal);
        process.removeListener('SIGHUP', onTermSignal);
        restoreCooked();
        if (borrowed) {
          this.resumeInput();
        }
        resolve(index);
      };

      readline.emitKeypressEvents(input);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(true);
      }
      input.resume();
      input.on('keypress', onKeypress);
      process.on('exit', restoreCooked);
      process.once('SIGTERM', onTermSignal);
      process.once('SIGHUP', onTermSignal);
    });
  }

  /**
   * Opens a persistent {@link LineEditor}. On a real TTY it returns the
   * raw-keypress editor (ghost-text, ESC-to-cancel, queued input); on any
   * non-TTY stdin (scripted tests, CI, pipes) it returns the deterministic
   * line/queue editor — gated on `interactive && hasTty(stdin)` (BOTH), so every
   * scripted-stdin path is byte-for-byte unchanged.
   */
  openLineEditor(options: LineEditorOptions = {}): LineEditor {
    const rawAllowed = process.env['EXCALIBUR_RAW_INPUT'] !== '0';
    const useRaw = this.interactive && hasTty(this.stdin) && rawAllowed;
    return useRaw ? this.openRawLineEditor(options) : this.openQueueLineEditor(options);
  }

  /**
   * The deterministic line/queue editor over a SINGLE long-lived
   * `readline.Interface` (`terminal: false`): a queue over the `line` event
   * drives reads identically on a real TTY or scripted memory streams, so tests
   * never depend on raw-TTY keypress handling. The per-call `ask`/`confirm`/
   * `select` prompts route through the same queue via `activeReader`.
   */
  private openQueueLineEditor(options: LineEditorOptions = {}): LineEditor {
    const rl = readline.createInterface({
      input: this.stdin,
      output: this.stdout,
      // `terminal: false` even when interactive: a queue over the `line` event
      // (below) drives reads deterministically, so we never depend on raw-TTY
      // keypress handling that a piped/scripted stdin cannot provide. Seeded
      // history is still consumed by readline for UP/DOWN on a real terminal.
      terminal: false,
      ...(options.history !== undefined ? { history: options.history } : {}),
      ...(options.completer !== undefined ? { completer: options.completer } : {}),
    });

    // A line queue decoupled from `rl.question`'s one-shot semantics: readline
    // emits `line` for every newline (buffering pre-written input), and each
    // `question` pulls the next line or waits for the next one. `close`/EOF
    // resolves any waiter with null (Ctrl-D).
    const lines: string[] = [];
    const waiters: Array<(line: string | null) => void> = [];
    let closed = false;

    rl.on('line', (line: string) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(line);
      } else {
        lines.push(line);
      }
    });
    rl.on('close', () => {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.(null);
      }
    });

    const nextLine = (): Promise<string | null> =>
      new Promise((resolve) => {
        const buffered = lines.shift();
        if (buffered !== undefined) {
          resolve(buffered);
        } else if (closed) {
          resolve(null);
        } else {
          waiters.push(resolve);
        }
      });

    const question = (prompt: string): Promise<string | null> => {
      this.writeRaw(prompt);
      return nextLine();
    };

    // While the editor is open, per-call prompts read through this same reader
    // (it owns prompt display — for the queue editor that's just writeRaw).
    this.activeReader = question;

    return {
      question,
      onSigint: (handler: () => void): (() => void) => {
        rl.on('SIGINT', handler);
        return (): void => {
          rl.removeListener('SIGINT', handler);
        };
      },
      // The queue editor has no raw keypresses, so turn-mode and ESC are no-ops
      // (cancellation here flows through SIGINT / Ctrl-C as before).
      setTurnActive: (): void => {},
      onEscape: (): (() => void) => (): void => {},
      close: (): void => {
        if (this.activeReader === question) {
          this.activeReader = null;
        }
        rl.close();
      },
    };
  }

  /**
   * The raw-keypress editor (M-Shell, real TTY only). Drives Node `keypress`
   * events through the pure {@link reduceKey} state machine, rendering the
   * prompt+buffer in place on every key (raw mode has no echo). Delivers full
   * lines on Enter via the same `lines[]`/`waiters[]` queue the line editor uses
   * (so `confirm`/`ask` mid-turn read finished lines), surfaces ESC (cancel a
   * turn) and Ctrl-C (SIGINT) to registered handlers, and — the safety
   * invariant — ALWAYS restores cooked mode (close + process `exit`).
   */
  private openRawLineEditor(options: LineEditorOptions = {}): LineEditor {
    const input = this.stdin as NodeJS.ReadStream;
    const out = this.stdout;
    const CR = String.fromCharCode(13);
    const ESC = String.fromCharCode(27);

    let state: RawInputState = initialRawState(options.history ?? []);
    let currentPrompt: string | null = null;
    const waiters: Array<(line: string | null) => void> = [];
    let closed = false;
    const sigintHandlers = new Set<() => void>();
    const escapeHandlers = new Set<() => void>();
    let rawActive = false;
    const ghostCommands = options.ghostCommands ?? [];
    const suggest = options.suggest;
    let suggestTimer: ReturnType<typeof setTimeout> | null = null;
    let suggestController: AbortController | null = null;
    let suggestSeq = 0; // monotonic: only the LATEST request may paint a ghost
    const GHOST_DEBOUNCE_MS = 280;

    const repaint = (): void => {
      if (currentPrompt !== null && state.awaiting) {
        out.write(renderInput(state, currentPrompt));
      }
    };

    /** Cancels any pending/in-flight model-ghost request. */
    const cancelSuggest = (): void => {
      if (suggestTimer !== null) {
        clearTimeout(suggestTimer);
        suggestTimer = null;
      }
      if (suggestController !== null) {
        suggestController.abort();
        suggestController = null;
      }
    };

    /**
     * Recomputes ghost-text for the current buffer: the INSTANT slash-completion
     * synchronously, then (debounced) an async MODEL suggestion that fills in
     * when there's no instant ghost and the buffer is still unchanged.
     */
    const refreshGhost = (): void => {
      cancelSuggest();
      const seq = ++suggestSeq;
      if (!state.awaiting) {
        return;
      }
      state = { ...state, ghost: instantGhost(state.buffer, ghostCommands) };
      if (suggest === undefined || state.ghost.length > 0 || state.buffer.trim().length === 0) {
        return; // instant ghost wins, or nothing to suggest
      }
      const at = state.buffer;
      suggestTimer = setTimeout(() => {
        const controller = new AbortController();
        suggestController = controller;
        void suggest(at, controller.signal)
          .then((completion) => {
            // Apply only if THIS is still the latest request, the user hasn't
            // typed since, we're still at the prompt, and no instant ghost took
            // over — so a stale (even same-text, cross-prompt) resolve can't paint.
            if (
              seq === suggestSeq &&
              completion !== null &&
              completion.length > 0 &&
              state.awaiting &&
              state.buffer === at &&
              state.ghost === ''
            ) {
              state = { ...state, ghost: completion };
              repaint();
            }
          })
          .catch(() => undefined);
      }, GHOST_DEBOUNCE_MS);
      if (typeof (suggestTimer as { unref?: () => void }).unref === 'function') {
        (suggestTimer as { unref: () => void }).unref();
      }
    };

    const onKeypress = (_str: string | undefined, key: ParsedKey | undefined): void => {
      if (key === undefined) {
        return;
      }
      try {
        const result = reduceKey(state, key);
        state = result.state;
        switch (result.action.type) {
          case 'submit': {
            cancelSuggest();
            out.write('\n'); // commit the typed line below the prompt
            currentPrompt = null;
            const waiter = waiters.shift();
            // A submit only occurs while a line is being read (awaiting ⇒ a waiter
            // exists), so there is always a waiter; drop otherwise rather than
            // silently buffer a line a later `confirm` could consume unseen.
            waiter?.(result.action.line);
            return;
          }
          case 'eof': {
            cancelSuggest();
            out.write('\n');
            closed = true;
            currentPrompt = null;
            while (waiters.length > 0) {
              waiters.shift()?.(null);
            }
            return;
          }
          case 'rewind': {
            // Esc-Esc at the prompt: resolve the pending read with the rewind
            // sentinel so the REPL opens the time-machine (which then drives its
            // own question() reads). A rewind only fires while awaiting, so a
            // waiter exists; drop harmlessly if somehow not. NEVER while a
            // sub-prompt (confirm/ask/select) is reading — the gesture is for
            // the main session line only.
            if (this.inSubPrompt) {
              repaint();
              return;
            }
            cancelSuggest();
            out.write('\n');
            currentPrompt = null;
            waiters.shift()?.(REWIND_SENTINEL);
            return;
          }
          case 'open_log': {
            // ↓ on the empty live line: resolve the pending read with the log
            // sentinel so the REPL opens the Session Log (which drives its own
            // question() reads). Mirrors the rewind path — suppressed during a
            // sub-prompt so a stray ↓ can't resolve a confirmation.
            if (this.inSubPrompt) {
              repaint();
              return;
            }
            cancelSuggest();
            out.write('\n');
            currentPrompt = null;
            waiters.shift()?.(LOG_SENTINEL);
            return;
          }
          case 'sigint':
            for (const handler of [...sigintHandlers]) {
              handler();
            }
            return;
          case 'abort':
            for (const handler of [...escapeHandlers]) {
              handler();
            }
            return;
          case 'none':
            // The reducer cleared the ghost on an edit; recompute it (instant +
            // debounced model) before repainting the line.
            refreshGhost();
            repaint();
            return;
        }
      } catch (error) {
        // A handler (or a write) threw inside the keypress callback. Restore the
        // terminal so it can NEVER be left in raw mode (no echo), degrade
        // gracefully so the REPL doesn't hang, and surface the error.
        failSafe(error);
      }
    };

    const restoreCooked = (): void => {
      try {
        if (input.isTTY === true && typeof input.setRawMode === 'function') {
          input.setRawMode(false);
        }
      } catch {
        // best-effort: never throw while restoring the terminal
      }
    };

    // Restore cooked mode on a terminating signal that does NOT emit `exit`
    // (SIGTERM/SIGHUP default-terminate without it), then re-exit. Scoped: added
    // on enable, removed on disable, so handlers never leak across editors.
    const onTermSignal = (): void => {
      restoreCooked();
      process.exit(143);
    };

    const enableRaw = (): void => {
      if (rawActive || input.isTTY !== true) {
        return;
      }
      readline.emitKeypressEvents(input);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(true);
      }
      input.resume();
      input.on('keypress', onKeypress);
      // `exit` covers normal/crash exits; the signal hooks cover SIGTERM/SIGHUP.
      process.on('exit', restoreCooked);
      process.once('SIGTERM', onTermSignal);
      process.once('SIGHUP', onTermSignal);
      rawActive = true;
    };

    const disableRaw = (): void => {
      if (!rawActive) {
        return;
      }
      input.removeListener('keypress', onKeypress);
      process.removeListener('exit', restoreCooked);
      process.removeListener('SIGTERM', onTermSignal);
      process.removeListener('SIGHUP', onTermSignal);
      restoreCooked();
      out.write(`${CR}${ESC}[2K`); // wipe any half-drawn prompt line
      rawActive = false;
    };

    /** Last-resort recovery if the keypress callback throws (see onKeypress). */
    const failSafe = (error: unknown): void => {
      disableRaw();
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.(null);
      }
      this.stderr.write(
        `${pc.red('✗')} input error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    };

    const question = (prompt: string): Promise<string | null> => {
      enableRaw();
      if (closed) {
        return Promise.resolve(null);
      }
      currentPrompt = prompt;
      // Slice 3: flush input typed DURING the turn into the next MAIN prompt line
      // (never a sub-prompt confirm/ask — that would eat the queued message).
      const queued = this.inSubPrompt ? '' : state.queue;
      state = {
        ...state,
        awaiting: true,
        buffer: queued,
        cursor: queued.length,
        historyIndex: -1,
        draft: '',
        ghost: '',
        queue: this.inSubPrompt ? state.queue : '',
      };
      out.write(renderInput(state, prompt));
      return new Promise((resolve) => {
        waiters.push((line) => {
          state = { ...state, awaiting: false };
          resolve(line);
        });
      });
    };

    this.activeReader = question;
    // Let the Ink live view borrow stdin during a turn: suspend drops raw mode +
    // the keypress listener; resume re-arms it (idempotent, lazy on the next read).
    this.suspendEditor = disableRaw;
    this.resumeEditor = enableRaw;

    return {
      question,
      onSigint: (handler: () => void): (() => void) => {
        sigintHandlers.add(handler);
        return (): void => {
          sigintHandlers.delete(handler);
        };
      },
      onEscape: (handler: () => void): (() => void) => {
        escapeHandlers.add(handler);
        return (): void => {
          escapeHandlers.delete(handler);
        };
      },
      setTurnActive: (active: boolean): void => {
        state = { ...state, mode: active ? 'turn' : 'prompt' };
      },
      close: (): void => {
        if (this.activeReader === question) {
          this.activeReader = null;
        }
        if (this.suspendEditor === disableRaw) {
          this.suspendEditor = null;
          this.resumeEditor = null;
        }
        closed = true; // set first (mirrors the eof path) so no re-entrant read races
        cancelSuggest();
        disableRaw();
        while (waiters.length > 0) {
          waiters.shift()?.(null);
        }
      },
    };
  }

  private async readLine(prompt: string): Promise<string> {
    // Delegate to the active persistent reader (the REPL editor) when one is
    // open, so a single reader owns stdin; otherwise spin up a throwaway
    // interface (the original per-call behavior, used by every subcommand). The
    // reader owns prompt display (raw editor renders it live), so we DON'T
    // writeRaw here when delegating.
    if (this.activeReader !== null) {
      // Suppress the live-line gestures (rewind / Session Log) for the duration
      // of this sub-prompt so a stray Esc-Esc / ↓ can't resolve it with a
      // sentinel string instead of a real answer.
      this.inSubPrompt = true;
      try {
        const line = await this.activeReader(prompt);
        return line ?? '';
      } finally {
        this.inSubPrompt = false;
      }
    }
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
