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
            // waiter exists; drop harmlessly if somehow not.
            cancelSuggest();
            out.write('\n');
            currentPrompt = null;
            waiters.shift()?.(REWIND_SENTINEL);
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
      state = { ...state, awaiting: true, buffer: '', cursor: 0, historyIndex: -1, draft: '', ghost: '' };
      out.write(renderInput(state, prompt));
      return new Promise((resolve) => {
        waiters.push((line) => {
          state = { ...state, awaiting: false };
          resolve(line);
        });
      });
    };

    this.activeReader = question;

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
      const line = await this.activeReader(prompt);
      return line ?? '';
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
