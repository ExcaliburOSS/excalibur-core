import * as readline from 'node:readline';
import pc from 'picocolors';
import { Spinner, isTtyStream } from './lib/spinner';
import { initialRawState, reduceKey, type ParsedKey, type RawInputState } from './lib/raw-input';
import {
  computeWindow,
  reduceSelectKey,
  renderChoiceLine,
  type SelectState,
} from './lib/select-input';
import {
  reduceMultiSelectKey,
  renderMultiChoiceLine,
  type MultiSelectState,
} from './lib/multi-select-input';
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
/**
 * Resolves a pending read when the editor RECOVERED from an internal fault (a
 * keypress/paint throw). NUL-prefixed so it can never be a real typed line. The
 * REPL treats it as "re-prompt", NOT as EOF (null) — a transient editor fault
 * must never look like Ctrl-D and exit the m-shell (RUN-FIX-18: nunca es nunca).
 */
export const RECOVER_SENTINEL = `${String.fromCharCode(0)}__excalibur_recover__`;

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

export interface MultiSelectOptions {
  /** Skip the prompt and resolve with the pre-checked defaults (the `--yes` flag). */
  yes?: boolean;
  /** Indices checked from the start (the high-confidence recommendations). */
  preselected?: number[];
  /** Dim navigation hint under the question (already translated). */
  navHint?: string;
  /**
   * Action hint shown BELOW the options (already translated) — repeats the
   * "press Enter to confirm" cue where the eye lands after scanning the list, so
   * the user is never left wondering how to commit. A `{count}` placeholder is
   * filled with the live number of checked rows. Omitted → a built-in default.
   */
  confirmHint?: string;
  /** Effective picker keybindings (P1.13b) — defaults to the built-in arrow/jk set. */
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
  /**
   * A dim hint shown inside an empty MAIN prompt line (there is no active
   * autocomplete). A function is RE-EVALUATED each time a prompt opens, so the
   * hint can be CONTEXTUAL to what just happened; a string is fixed. It vanishes
   * the moment the user types and is never shown on a sub-prompt.
   */
  placeholder?: string | (() => string);
  /**
   * Slash commands for the in-line command MENU: when the buffer is a single
   * `/token`, the editor lists the matching commands (name + brief description)
   * and filters them as the user types. ↑/↓ highlight, Tab/→ autocompletes.
   */
  commands?: { name: string; description: string }[];
  /**
   * A persistent FOOTER framed below the MAIN input line (RUN-FIX-11): each entry
   * is one rendered line (e.g. an accent hairline + a hint row of model · autonomy
   * · permissions · shortcuts). RE-EVALUATED on every paint so it reflects live
   * state, and rendered with the SAME cursor-up / erase-to-end-of-screen mechanism
   * as the slash menu (so the cursor parks back on the input). Skipped on a
   * sub-prompt and while the slash menu is open. Lines must be single visual rows.
   */
  footer?: () => string[];
  /**
   * A persistent HEADER framed ABOVE the MAIN input line — the input box's TOP
   * rule. Drawn by the editor as part of the SAME redraw as the prompt + footer,
   * so the framed box wraps ONLY the live input (never scrollback/history above
   * it). Re-evaluated every paint; skipped on a sub-prompt and while the slash
   * menu is open. Lines must be single visual rows.
   */
  header?: () => string[];
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
  /**
   * Re-arms the editor after a NON-user null read (a bare Ctrl-D or a spurious EOF
   * delivered during the Ink→raw-editor stdin handoff after a gated build): clears the
   * `closed` state (unless the user intentionally closed) and re-enables raw input so the
   * next {@link question} reads a fresh line. The m-shell must never exit on such a null
   * (RUN-FIX-25) — only an explicit `/exit` or a deliberate double-Ctrl-C ends it.
   */
  reopen(): void;
  /**
   * True only when the editor was closed by DELIBERATE user intent ({@link close}, from a
   * double-Ctrl-C or teardown) — NOT when a bare Ctrl-D / spurious EOF keypress set `closed`.
   * The REPL breaks its loop on a null read ONLY when this is true; otherwise it re-prompts.
   */
  wasClosedByUser(): boolean;
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
   * ARMORED — set by the interactive m-shell (RUN-FIX-20). While armored, the
   * per-prompt SIGTERM/SIGHUP handlers restore cooked mode but DO NOT exit the
   * process: the shell must never die on a stray signal mid-session; the REPL's
   * own armor decides survival, and the only real exits are explicit user intent.
   * Off by default so one-shot subcommands (`excalibur run`, etc.) still terminate
   * on a signal as scripts expect.
   */
  private armored = false;
  /** Arm/disarm the never-exit-on-signal posture (the interactive m-shell). */
  setArmored(value: boolean): void {
    this.armored = value;
  }
  /**
   * Nesting depth of {@link suspendInput} calls. suspend/resume are
   * REFERENCE-COUNTED so only the OUTERMOST suspend drops raw mode and only the
   * matching outermost resume re-arms it: a command run in-process from the shell
   * (e.g. `/mission`, whose per-step agent turns each suspend→mount Ink→resume)
   * must NOT let an inner resume re-arm the REPL editor while the outer
   * passthrough still owns stdin. Reset to 0 whenever a fresh editor registers.
   */
  private suspendDepth = 0;
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
    // Only the outermost suspend actually drops raw mode (ref-counted).
    if (this.suspendDepth === 0) {
      this.suspendEditor?.();
    }
    this.suspendDepth += 1;
  }

  /** Re-arms the raw editor's stdin ownership after an Ink turn. */
  resumeInput(): void {
    this.suspendDepth = Math.max(0, this.suspendDepth - 1);
    // Only re-arm once the LAST matching resume lands (or a stray resume with no
    // outstanding suspend — re-arm is idempotent under the rawActive guard).
    if (this.suspendDepth === 0) {
      this.resumeEditor?.();
    }
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
      // While the interactive m-shell is ARMORED, never terminate on a stray signal —
      // restore the terminal and let the REPL's armor keep the session alive (RUN-FIX-20).
      if (!this.armored) process.exit(143);
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
            // Armored (RUN-FIX-22): cancel the secret prompt (finish above), don't
            // self-SIGINT the shell → exit 130. Un-armored CLI keeps the kill.
            if (!this.armored) process.kill(process.pid, 'SIGINT');
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
      // While the interactive m-shell is ARMORED, never terminate on a stray signal —
      // restore the terminal and let the REPL's armor keep the session alive (RUN-FIX-20).
      if (!this.armored) process.exit(143);
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
              // While the REPL is ARMORED (RUN-FIX-22), a single Ctrl-C in a sub-prompt
              // (/models, onboarding, plan-shaping) must CANCEL the picker — already done
              // by finish() above — NOT self-send a SIGINT the armored shell never
              // registered a handler for, which would exit 130. Un-armored direct-CLI
              // paths keep the kill so non-interactive Ctrl-C is unchanged.
              if (!this.armored) process.kill(process.pid, 'SIGINT');
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
   * MULTI-select chooser (plan-shaping): returns the chosen zero-based indices.
   * On a real TTY it is an INTERACTIVE checkbox list — ↑/↓ (and j/k) move, SPACE
   * toggles, `a`/`n` select all/none, Enter confirms the current selection (which
   * starts pre-checked), and Esc SKIPS (resolves with an EMPTY set — adds nothing,
   * matching the "esc skip" hint). Non-TTY / `--yes` / `EXCALIBUR_RAW_INPUT=0`
   * resolve to `preselected` (a scripted/auto path keeps the recommended set, no
   * prompt). Best-effort: a terminal fault restores the editor and skips (empty).
   */
  async multiSelect(
    question: string,
    choices: SelectChoice[],
    options: MultiSelectOptions = {},
  ): Promise<number[]> {
    const valid = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < choices.length;
    const preselected = [...new Set((options.preselected ?? []).filter(valid))].sort(
      (a, b) => a - b,
    );
    const rawAllowed = process.env['EXCALIBUR_RAW_INPUT'] !== '0';
    const useArrows =
      options.yes !== true &&
      this.interactive &&
      hasTty(this.stdin) &&
      this.isOutputTty() &&
      rawAllowed &&
      choices.length > 0;
    if (!useArrows) {
      return preselected; // scripted / --yes / non-TTY → accept the recommended set
    }
    return this.multiSelectInteractive(
      question,
      choices,
      preselected,
      options.navHint,
      options.keymap,
      options.confirmHint,
    );
  }

  /** The interactive checkbox chooser (real TTY) — mirrors {@link selectInteractive}. */
  private multiSelectInteractive(
    question: string,
    choices: SelectChoice[],
    preselected: number[],
    navHint?: string,
    keymap?: SelectKeymap,
    confirmHint?: string,
  ): Promise<number[]> {
    const input = this.stdin as NodeJS.ReadStream;
    const out = this.stdout;
    const ESC = String.fromCharCode(27);
    const ascii = process.env['EXCALIBUR_ASCII'] === '1';
    const total = choices.length;
    const rows = (out as { rows?: number }).rows ?? 24;
    const windowSize = Math.max(4, Math.min(12, rows - 6));
    let state: MultiSelectState = { index: 0, selected: new Set(preselected) };
    // Esc / Ctrl-C / any fault resolve with an EMPTY set — a true SKIP that adds
    // nothing (NOT the user's half-made edits), matching the "esc skip" hint.
    const SKIP: number[] = [];

    const borrowed = this.suspendEditor !== null;
    if (borrowed) {
      this.suspendInput();
    }

    let linesDrawn = 0;
    const block = (): string[] => {
      const lines: string[] = [this.formatQuestion(question)];
      lines.push(
        pc.dim(navHint ?? '↑/↓ move · space toggle · a/n all/none · enter confirm · esc skip'),
      );
      const { start, end } = computeWindow(state.index, total, windowSize);
      if (start > 0) {
        lines.push(pc.dim(`  ▲ ${start} more`));
      }
      for (let i = start; i < end; i += 1) {
        lines.push(
          renderMultiChoiceLine(
            choices[i] as SelectChoice,
            i === state.index,
            state.selected.has(i),
            ascii,
          ),
        );
      }
      if (end < total) {
        lines.push(pc.dim(`  ▼ ${total - end} more`));
      }
      // A confirm cue BELOW the list — where the eye rests after scanning the
      // options — so "press Enter to confirm" is never only above the fold. The
      // `{count}` reflects the live checked total; a cyan ⏎ draws the action.
      const enter = ascii ? '>' : '⏎';
      const filled = (
        confirmHint ?? 'Press Enter to confirm ({count} selected) · Space toggle'
      ).replace('{count}', String(state.selected.size));
      lines.push('');
      lines.push(`${pc.cyan(enter)} ${pc.dim(filled)}`);
      return lines;
    };
    const draw = (): void => {
      if (linesDrawn > 0) {
        out.write(`${ESC}[${linesDrawn}A`);
      }
      out.write(`\r${ESC}[0J`);
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
      // While the interactive m-shell is ARMORED, never terminate on a stray signal —
      // restore the terminal and let the REPL's armor keep the session alive (RUN-FIX-20).
      if (!this.armored) process.exit(143);
    };

    draw();
    return new Promise<number[]>((resolve) => {
      let done = false;
      const finish = (result: number[]): void => {
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
        resolve(result);
      };
      const onKeypress = (_str: string | undefined, key: ParsedKey | undefined): void => {
        if (key === undefined) {
          return;
        }
        try {
          const result = reduceMultiSelectKey(state, key, total, keymap);
          state = result.state;
          switch (result.action.type) {
            case 'move':
            case 'toggle':
              draw();
              return;
            case 'submit':
              draw();
              finish(result.action.selected);
              return;
            case 'cancel':
              finish(SKIP);
              return;
            case 'sigint':
              out.write('\n');
              finish(SKIP);
              // Armored sub-prompt Ctrl-C cancels (finish above), never self-SIGINT → exit
              // 130 (RUN-FIX-22). Un-armored CLI paths keep the kill.
              if (!this.armored) process.kill(process.pid, 'SIGINT');
              return;
            case 'none':
              return;
          }
        } catch {
          finish(SKIP);
        }
      };
      // Entering raw mode can throw (e.g. EIO/ENOTTY on a TTY that just went
      // away). If it does, finish() restores cooked mode, resumes the borrowed
      // editor, and resolves with SKIP — so we never throw or leave it suspended.
      try {
        readline.emitKeypressEvents(input);
        if (typeof input.setRawMode === 'function') {
          input.setRawMode(true);
        }
        input.resume();
        input.on('keypress', onKeypress);
        process.on('exit', restoreCooked);
        process.once('SIGTERM', onTermSignal);
        process.once('SIGHUP', onTermSignal);
      } catch {
        finish(SKIP);
      }
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
      // Non-TTY / piped input: a null read IS a genuine end-of-stream (the pipe closed), so
      // the REPL SHOULD end. There is no raw stdin to re-arm, so reopen is a no-op.
      reopen: (): void => {},
      wasClosedByUser: (): boolean => true,
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
    // DELIBERATE close (double-Ctrl-C via close(), or teardown) vs. a `closed` set by a bare
    // Ctrl-D / spurious EOF keypress. The REPL only EXITS on a null read when this is true;
    // a non-user null re-arms + re-prompts (RUN-FIX-25 — the shell never exits on its own).
    let intentionallyClosed = false;
    const sigintHandlers = new Set<() => void>();
    const escapeHandlers = new Set<() => void>();
    let rawActive = false;
    // Autocomplete/model-ghost suggestions were removed (they suggested noise).
    // Instead: a dim CONTEXTUAL placeholder on the empty line, and a deterministic
    // slash-command MENU that filters as you type `/…`. `suggest` / `ghostCommands`
    // options are accepted for compatibility but ignored.
    const placeholderOf = options.placeholder;
    let currentPlaceholder = '';
    const commands = options.commands ?? [];
    const stripAnsi = (s: string): string => s.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');
    const termCols = (): number => {
      const c = (out as { columns?: number }).columns;
      return typeof c === 'number' && c > 0 ? c : 80;
    };

    // Slash-command menu: active when the buffer is a single `/token` on the MAIN
    // line. `menuItems` are the commands whose name starts with the typed token.
    const SLASH_RE = /^\/[^\s]*$/;
    let menuItems: { name: string; description: string }[] = [];
    let menuIndex = 0;
    const recomputeMenu = (): void => {
      if (this.inSubPrompt || commands.length === 0 || !SLASH_RE.test(state.buffer)) {
        menuItems = [];
        menuIndex = 0;
        return;
      }
      const typed = state.buffer.slice(1).toLowerCase();
      menuItems = commands.filter((c) => c.name.startsWith(typed));
      if (menuIndex >= menuItems.length) {
        menuIndex = 0;
      }
    };

    // The row (0-indexed from the FIRST input row) the cursor was parked on by the
    // last paint. The next paint steps UP by `prevCursorRow` to the first input row,
    // then erases to end-of-screen — wiping input + footer (the slash menu OR the
    // framed hint, RUN-FIX-11) in one shot WITHOUT walking the prompt up the screen.
    let prevCursorRow = 0;
    // Rows the input itself occupied in the last paint (≥ 1). Used when a read
    // ends to drop BELOW the input and erase the framed footer (RUN-FIX-11).
    let lastInputRows = 1;
    // Rows the framed HEADER (top rule) occupied last paint, so the close/erase
    // math can account for the rows ABOVE the prompt.
    let lastHeaderRows = 0;

    const paint = (): void => {
      if (currentPrompt === null || !state.awaiting) {
        return;
      }
      const cols = termCols();
      // The framed HEADER (top rule) — drawn ABOVE the prompt as part of the SAME
      // redraw, so the box wraps ONLY the live input (scrollback/history stays above).
      // The header/footer closures call into live runtime state (autonomy/permissions/
      // i18n) — a throw there must NEVER escape paint (it would unwind out of the REPL
      // prompt read and exit the shell, RUN-FIX-18); degrade to no chrome instead.
      let headerLines: string[] = [];
      if (options.header !== undefined && !this.inSubPrompt) {
        try {
          headerLines = options.header();
        } catch {
          headerLines = [];
        }
      }
      const headerStr = headerLines.map((l) => `${l}\n`).join('');
      const headerRows = headerLines.reduce(
        (sum, l) => sum + Math.max(1, Math.ceil(Math.max(1, stripAnsi(l).length) / cols)),
        0,
      );
      const showPlaceholder =
        state.buffer.length === 0 && currentPlaceholder.length > 0 && !this.inSubPrompt;
      const body = showPlaceholder ? pc.dim(currentPlaceholder) : state.buffer;
      const promptVis = stripAnsi(currentPrompt).length;
      const bodyVis = showPlaceholder ? currentPlaceholder.length : state.buffer.length;
      const inputRows = Math.max(1, Math.ceil(Math.max(1, promptVis + bodyVis) / cols));

      // The footer below the input: the slash-command MENU when it is open,
      // otherwise the persistent framed hint (RUN-FIX-11). Suppressed on a
      // sub-prompt. One visual row per entry.
      let footerLines: string[];
      if (menuItems.length > 0) {
        footerLines = menuItems.map((it, i) =>
          i === menuIndex
            ? `${pc.cyan(`▸ /${it.name}`)}  ${pc.dim(it.description)}`
            : `${pc.dim(`  /${it.name}`)}  ${pc.dim(it.description)}`,
        );
      } else if (options.footer !== undefined && !this.inSubPrompt) {
        try {
          footerLines = options.footer();
        } catch {
          footerLines = [];
        }
      } else {
        footerLines = [];
      }
      const footerStr = footerLines.map((l) => `\n${l}`).join('');
      // Count VISUAL rows, not array entries: a footer line wider than the terminal
      // auto-wraps, and the cursor-up math below must account for those extra rows
      // (else the cursor parks on the wrong line).
      const footerRows = footerLines.reduce(
        (sum, l) => sum + Math.max(1, Math.ceil(Math.max(1, stripAnsi(l).length) / cols)),
        0,
      );

      // The cursor's row/column inside the input block (0-indexed from the FIRST
      // input row, i.e. below the header). With header + footer, the cursor steps
      // back to it after the box is redrawn.
      const cursorAbs = promptVis + (showPlaceholder ? 0 : state.cursor);
      const cursorRowInInput = Math.floor(cursorAbs / cols);
      const cursorCol = cursorAbs % cols;

      let seq = '';
      if (prevCursorRow > 0) {
        // Up to the BOX TOP (the header's first row) — NEVER above it, so the erase
        // below can't reach the welcome/conversation/scrollback.
        seq += `${ESC}[${prevCursorRow}A`;
      }
      seq += `${CR}${ESC}[0J`; // col 0, erase from the box top to end of screen
      seq += headerStr + currentPrompt + body + footerStr;
      // Park the cursor back on the input line at the insertion point: from the last
      // written row, step up over the rest of the wrapped input + the whole footer
      // (the header is ABOVE the cursor, so it doesn't enter this count).
      const downBelowCursor = inputRows - 1 - cursorRowInInput + footerRows;
      if (downBelowCursor > 0) {
        seq += `${ESC}[${downBelowCursor}A`;
      }
      seq += CR;
      if (cursorCol > 0) {
        seq += `${ESC}[${cursorCol}C`;
      }
      try {
        out.write(seq);
      } catch {
        // A write to a half-closed terminal (EPIPE) must not unwind out of the
        // prompt read and exit the shell (RUN-FIX-18) — drop this frame instead.
        return;
      }
      // prevCursorRow is measured from the BOX TOP (header), so the next paint steps
      // up to the header and redraws the WHOLE box.
      prevCursorRow = headerRows + cursorRowInInput;
      lastInputRows = inputRows;
      lastHeaderRows = headerRows;
    };
    const repaint = paint;

    // Ends a read cleanly: from the parked cursor, drop to the row just BELOW the
    // input and erase the framed footer (hairline + hint), leaving the cursor on a
    // fresh line so the typed message stays and the next output starts clean. Used
    // in place of a bare `\n` now that a footer may sit below the input (RUN-FIX-11).
    const closeFrame = (): void => {
      // From the parked cursor (rows-from-box-top), drop to just BELOW the input
      // (past the header + input rows) and erase the framed footer there.
      const down = Math.max(1, lastHeaderRows + lastInputRows - prevCursorRow);
      out.write(`${CR}${ESC}[${down}B${ESC}[0J`);
      prevCursorRow = 0;
      lastInputRows = 1;
      lastHeaderRows = 0;
    };

    const onKeypress = (_str: string | undefined, key: ParsedKey | undefined): void => {
      if (key === undefined) {
        return;
      }
      try {
        // The slash-command menu intercepts navigation/accept keys BEFORE the
        // reducer: ↑/↓ move the highlight (not history), Tab/→-at-end fills in
        // the highlighted command. Everything else falls through to edit + filter.
        if (menuItems.length > 0 && key.ctrl !== true && key.meta !== true) {
          if (key.name === 'up') {
            menuIndex = (menuIndex - 1 + menuItems.length) % menuItems.length;
            paint();
            return;
          }
          if (key.name === 'down') {
            menuIndex = (menuIndex + 1) % menuItems.length;
            paint();
            return;
          }
          const atEnd = state.cursor >= state.buffer.length;
          if (key.name === 'tab' || (key.name === 'right' && atEnd)) {
            const chosen = menuItems[menuIndex];
            if (chosen !== undefined) {
              const buf = `/${chosen.name} `;
              state = {
                ...state,
                buffer: buf,
                cursor: buf.length,
                ghost: '',
                historyIndex: -1,
                draft: '',
              };
              recomputeMenu();
              paint();
            }
            return;
          }
        }
        const result = reduceKey(state, key);
        state = result.state;
        switch (result.action.type) {
          case 'submit': {
            closeFrame(); // erase the framed footer; the typed line stays committed
            currentPrompt = null;
            const waiter = waiters.shift();
            // A submit only occurs while a line is being read (awaiting ⇒ a waiter
            // exists), so there is always a waiter; drop otherwise rather than
            // silently buffer a line a later `confirm` could consume unseen.
            waiter?.(result.action.line);
            return;
          }
          case 'eof': {
            closeFrame();
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
            closeFrame();
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
            closeFrame();
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
            // Re-filter the command menu (buffer may have changed) and re-render.
            recomputeMenu();
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
      // While the interactive m-shell is ARMORED, never terminate on a stray signal —
      // restore the terminal and let the REPL's armor keep the session alive (RUN-FIX-20).
      if (!this.armored) process.exit(143);
    };

    // Terminal RESIZE: redraw the framed box at the new width so the full-width
    // accent rules re-span the terminal the instant the window changes (only while
    // a prompt is open; the next paint reads the live `termCols()`).
    const onResize = (): void => {
      if (currentPrompt !== null && state.awaiting && !this.inSubPrompt) {
        repaint();
      }
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
      (out as NodeJS.WriteStream).on?.('resize', onResize);
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
      (out as NodeJS.WriteStream).removeListener?.('resize', onResize);
      process.removeListener('exit', restoreCooked);
      process.removeListener('SIGTERM', onTermSignal);
      process.removeListener('SIGHUP', onTermSignal);
      restoreCooked();
      // Step up only to the FIRST input row (never above it), then erase to end of
      // screen — wipes the prompt + footer (menu or hint) without touching scrollback.
      if (prevCursorRow > 0) out.write(`${ESC}[${prevCursorRow}A`);
      out.write(`${CR}${ESC}[0J`); // wipe any half-drawn (possibly wrapped) prompt + footer
      prevCursorRow = 0;
      rawActive = false;
    };

    /**
     * Recovery if the keypress callback throws (see onKeypress). The m-shell must
     * NEVER exit on a transient input fault (RUN-FIX-18: nunca es nunca), so this
     * does NOT close the editor: it disarms raw mode, RESETS the buffer to a clean
     * state (the throw may have corrupted it), and resolves the in-flight read with
     * the RECOVER sentinel — NOT null. A null would look like Ctrl-D/EOF to the REPL
     * and break its loop → teardown → exit; the sentinel tells it to simply re-prompt
     * (raw mode re-arms lazily on the next read). `closed` stays false.
     */
    const failSafe = (error: unknown): void => {
      try {
        disableRaw();
      } catch {
        /* never throw while recovering the terminal */
      }
      state = initialRawState(options.history ?? []);
      currentPrompt = null;
      prevCursorRow = 0;
      try {
        this.stderr.write(
          `${pc.yellow('⚠')} input recovered: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } catch {
        /* surfacing is best-effort */
      }
      while (waiters.length > 0) {
        waiters.shift()?.(RECOVER_SENTINEL);
      }
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
      // Re-evaluate the contextual placeholder for THIS prompt (a function hint
      // adapts to what just happened); the menu reflects any queued slash text. The
      // function form reads live runtime state — a throw must NEVER escape question()
      // (it would unwind out of the REPL prompt read and exit the shell, RUN-FIX-18).
      try {
        currentPlaceholder = this.inSubPrompt
          ? ''
          : typeof placeholderOf === 'function'
            ? placeholderOf()
            : (placeholderOf ?? '');
      } catch {
        currentPlaceholder = '';
      }
      recomputeMenu();
      prevCursorRow = 0;
      paint();
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
    this.suspendDepth = 0; // a fresh editor starts un-suspended (clear any stale count)

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
        intentionallyClosed = true; // a DELIBERATE close (double-Ctrl-C / teardown) — the REPL may exit
        closed = true; // set first (mirrors the eof path) so no re-entrant read races
        disableRaw();
        while (waiters.length > 0) {
          waiters.shift()?.(null);
        }
      },
      // Re-arm after a NON-user null (a bare Ctrl-D or a spurious EOF from the Ink→raw stdin
      // handoff after a gated build). Clears `closed` and re-enables raw input so the next
      // question() reads a fresh line. Refuses if the user deliberately closed the shell.
      reopen: (): void => {
        if (intentionallyClosed) {
          return;
        }
        closed = false;
        state = { ...state, awaiting: false };
        enableRaw();
      },
      wasClosedByUser: (): boolean => intentionallyClosed,
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
