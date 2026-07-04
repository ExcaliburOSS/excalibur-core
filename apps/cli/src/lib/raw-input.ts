/**
 * The pure keystroke state machine for the raw-keypress line editor (M-Shell).
 *
 * Splitting the reducer from `process.stdin`/`stdout` is what makes the raw
 * editor testable WITHOUT a TTY (the sandbox/CI has none): feed synthetic
 * {@link ParsedKey} events to {@link reduceKey} and assert the next state + the
 * emitted {@link RawAction}; snapshot {@link renderInput}'s bytes for cursor
 * math. The thin I/O shell in `ui.ts` wires Node's `keypress` events into this
 * reducer, applies the action, and writes `renderInput(...)`.
 *
 * Slice 1 scope: full line editing at the prompt (insert / backspace / delete /
 * cursor / home / end / history ↑↓) + Enter/Ctrl-D/Ctrl-C, and — the headline —
 * ESC cancels an in-flight turn. Ghost-text (Slice 2) and queued input (Slice 3)
 * extend this machine later; their hooks (`ghost`, `queue`, the `queue` action)
 * are intentionally absent here to keep this slice small.
 */

import pc from 'picocolors';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const CLEAR_LINE = `${CR}${ESC}[2K`; // CR + "erase entire line"

/** The reducer's view of one decoded key (matches Node's `keypress` `key`). */
export interface ParsedKey {
  /** The raw byte sequence (the char itself for a printable key). */
  sequence?: string;
  /** Decoded name: `return`,`backspace`,`left`,`up`,`home`,`escape`,`tab`,… */
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** The mutable input state. `mode` is set by the REPL via `setTurnActive`. */
export interface RawInputState {
  /** Committed text on the current line. */
  buffer: string;
  /** Insertion index within `buffer` (0..buffer.length). */
  cursor: number;
  /** Prompt history, NEWEST FIRST (as readline expects). */
  history: string[];
  /** -1 = editing a live draft; 0..history.length-1 = recalled entry. */
  historyIndex: number;
  /** The live draft saved when the user starts navigating history. */
  draft: string;
  /**
   * Ghost-text: a dim, not-yet-accepted completion SUFFIX shown after the
   * buffer (e.g. typing `/re` ghosts `play`). Accepted with Tab or → at the end
   * of the buffer; cleared on any edit (the shell recomputes it). Set by the
   * shell (instant slash/command completion, or an async model suggestion) — the
   * reducer only clears/accepts it, never invents it.
   */
  ghost: string;
  /** `turn` = a turn is in flight (set via setTurnActive); `prompt` otherwise. */
  mode: 'prompt' | 'turn';
  /**
   * True while a line is actively being READ (the REPL prompt, or a confirm/ask
   * during a turn). This — not `mode` — gates editing: a confirm mid-turn is
   * still editable, while idle typing during a model call (no reader) is not.
   * ESC aborts the turn only when NOT awaiting a line; while awaiting it clears
   * the input buffer (ESC must never resolve a read to null / exit the REPL).
   */
  awaiting: boolean;
  /**
   * True for exactly one keystroke after a FIRST ESC at the prompt: a second
   * consecutive ESC (nothing typed between) opens the rewind time-machine —
   * Claude Code's Esc-Esc. Set only at the prompt (never a mid-turn confirm) and
   * cleared by any non-ESC key; the {@link reduceKey} wrapper enforces the
   * one-keystroke lifetime.
   */
  escapePrimed: boolean;
  /**
   * Slice 3 — queued input: text typed WHILE a turn is in flight (no line is
   * being read). It accumulates here (printable + backspace) and is flushed into
   * the next prompt's `buffer` when the read opens, so you can start writing your
   * next message while the agent works. Empty whenever not mid-turn-typing.
   */
  queue: string;
  /**
   * D5 (F1.5) — TRUE between the terminal's bracketed-paste markers
   * (`ESC[200~` … `ESC[201~`, decoded by Node as `paste-start`/`paste-end`).
   * While pasting, every key is CONTENT: Enter becomes a literal newline (never
   * a submit), Tab a literal tab — so a pasted stack trace lands as ONE
   * multi-line message instead of N surprise submits.
   */
  pasting: boolean;
}

/** What a keystroke asks the shell to do. */
export type RawAction =
  | { type: 'submit'; line: string } // Enter at the prompt → resolve question()
  | { type: 'abort' } // ESC while a turn is in flight → cancel it
  | { type: 'rewind' } // Esc-Esc at the prompt → open the rewind time-machine
  | { type: 'open_log' } // ↓ on the empty live line → open the Session Log
  | { type: 'eof' } // Ctrl-D on an empty buffer → null (EOF)
  | { type: 'sigint' } // Ctrl-C → the SIGINT handler (cancel / exit)
  | { type: 'none' };

/** A fresh prompt state seeded with the session history (newest first). */
export function initialRawState(history: string[] = []): RawInputState {
  return {
    buffer: '',
    cursor: 0,
    history: [...history],
    historyIndex: -1,
    draft: '',
    ghost: '',
    mode: 'prompt',
    awaiting: false,
    escapePrimed: false,
    queue: '',
    pasting: false,
  };
}

const NONE: RawAction = { type: 'none' };

/**
 * True when `seq` is one or more PRINTABLE characters (no C0 control or DEL) —
 * so a single key, an emoji (multiple UTF-16 units) or a pasted run of ASCII all
 * insert, while control bytes (ESC, CR, LF, …) never sneak in. (Display WIDTH of
 * wide glyphs is a v1 limitation: the cursor math counts UTF-16 units.)
 */
function isPrintableSeq(seq: string | undefined): seq is string {
  if (seq === undefined || seq.length === 0) {
    return false;
  }
  for (const ch of seq) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** Clamp helper. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

const WS = /\s/;
/** #5 — the start of the word before `cursor`: skip trailing whitespace, then the
 * run of non-whitespace. Whitespace-delimited (predictable across languages/paths). */
function wordLeft(buffer: string, cursor: number): number {
  let i = clamp(cursor, 0, buffer.length);
  while (i > 0 && WS.test(buffer[i - 1]!)) i -= 1;
  while (i > 0 && !WS.test(buffer[i - 1]!)) i -= 1;
  return i;
}
/** #5 — the end of the word after `cursor`: skip leading whitespace, then the run
 * of non-whitespace. */
function wordRight(buffer: string, cursor: number): number {
  let i = clamp(cursor, 0, buffer.length);
  while (i < buffer.length && WS.test(buffer[i]!)) i += 1;
  while (i < buffer.length && !WS.test(buffer[i]!)) i += 1;
  return i;
}

/**
 * D5 (F1.5) — visual layout of a possibly MULTI-LINE input. Every logical line
 * (split on `\n`) is prefixed by the prompt (first line) or an equal-width
 * continuation indent, so wrapped-row counting and the cursor position reduce to
 * one formula per line. Pure — the editor's repaint math and tests share it.
 * (Width counts UTF-16 units — the pre-existing v1 limitation for wide glyphs.)
 */
export function layoutInput(
  buffer: string,
  cursor: number,
  promptVis: number,
  cols: number,
): { rows: number; cursorRow: number; cursorCol: number } {
  const lines = buffer.split('\n');
  let rows = 0;
  let cursorRow = 0;
  let cursorCol = promptVis % Math.max(1, cols);
  let index = 0; // chars consumed, counting the `\n` separators
  let found = false;
  for (const line of lines) {
    const start = index;
    const end = index + line.length;
    if (!found && cursor >= start && cursor <= end) {
      const abs = promptVis + (cursor - start);
      cursorRow = rows + Math.floor(abs / Math.max(1, cols));
      cursorCol = abs % Math.max(1, cols);
      found = true;
    }
    rows += Math.max(1, Math.ceil(Math.max(1, promptVis + line.length) / Math.max(1, cols)));
    index = end + 1;
  }
  return { rows: Math.max(1, rows), cursorRow, cursorCol };
}

/**
 * The pure reducer: given the current state and a decoded key, return the next
 * state and the action the shell must take. Never mutates its input.
 *
 * Wraps {@link reduceKeyInner} to enforce the one-keystroke lifetime of
 * `escapePrimed`: it is set only by a first prompt-ESC and consumed by the
 * rewind it triggers — ANY other key clears it, so two ESCs must be CONSECUTIVE
 * to open the time-machine.
 */
export function reduceKey(
  state: RawInputState,
  key: ParsedKey,
): { state: RawInputState; action: RawAction } {
  const result = reduceKeyInner(state, key);
  const isEscape = key.name === 'escape' && key.ctrl !== true && key.meta !== true;
  if (!isEscape && result.state.escapePrimed) {
    return { state: { ...result.state, escapePrimed: false }, action: result.action };
  }
  return result;
}

function reduceKeyInner(
  state: RawInputState,
  key: ParsedKey,
): { state: RawInputState; action: RawAction } {
  // Any edit clears the ghost by default (the shell recomputes it); a case that
  // wants to keep/accept the ghost sets it explicitly.
  const keep = (next: Partial<RawInputState>): { state: RawInputState; action: RawAction } => ({
    state: { ...state, ghost: '', ...next },
    action: NONE,
  });

  // D5 — bracketed-paste markers toggle CONTENT mode. Checked before everything
  // (including Ctrl-C): pasted control bytes must never fire shell actions; the
  // terminal always closes the paste with `paste-end`, restoring normal keys.
  if (key.name === 'paste-start') {
    return { state: { ...state, pasting: true }, action: NONE };
  }
  if (key.name === 'paste-end') {
    return { state: { ...state, pasting: false }, action: NONE };
  }
  if (state.pasting) {
    const text =
      key.name === 'return' || key.name === 'enter'
        ? '\n'
        : key.name === 'tab'
          ? '\t'
          : isPrintableSeq(key.sequence)
            ? key.sequence
            : '';
    if (text.length === 0) {
      return { state, action: NONE }; // pasted control bytes are dropped, never actions
    }
    if (!state.awaiting) {
      // Mid-turn paste lands in the queue (flushed into the next prompt).
      return state.mode === 'turn'
        ? { state: { ...state, queue: state.queue + text }, action: NONE }
        : { state, action: NONE };
    }
    return keep({
      buffer: state.buffer.slice(0, state.cursor) + text + state.buffer.slice(state.cursor),
      cursor: state.cursor + text.length,
    });
  }

  // Ctrl-C is the SIGINT path always (under raw mode it arrives as a key).
  if (key.ctrl === true && key.name === 'c') {
    return { state, action: { type: 'sigint' } };
  }

  // --- not reading a line: a turn is running with just the spinner. ESC cancels
  // it; printable keys + backspace QUEUE editable input (Slice 3), flushed into
  // the next prompt; everything else is ignored. ---
  if (!state.awaiting) {
    if (state.mode === 'turn') {
      if (key.name === 'escape' && key.ctrl !== true && key.meta !== true) {
        return { state, action: { type: 'abort' } };
      }
      if (key.name === 'backspace') {
        return { state: { ...state, queue: state.queue.slice(0, -1) }, action: NONE };
      }
      if (isPrintableSeq(key.sequence)) {
        return { state: { ...state, queue: state.queue + key.sequence }, action: NONE };
      }
    }
    return { state, action: NONE };
  }

  // --- awaiting a line (the prompt, or a confirm/ask mid-turn): full editing ---
  if (key.ctrl === true) {
    switch (key.name) {
      case 'a':
        return keep({ cursor: 0 });
      case 'e':
        return keep({ cursor: state.buffer.length });
      case 'u': // kill to line start
        return keep({ buffer: state.buffer.slice(state.cursor), cursor: 0 });
      case 'k': // #5 — kill to line END (the Ctrl-U counterpart)
        return keep({ buffer: state.buffer.slice(0, state.cursor) });
      case 'w': {
        // #5 — delete the WORD before the cursor
        const start = wordLeft(state.buffer, state.cursor);
        return keep({
          buffer: state.buffer.slice(0, start) + state.buffer.slice(state.cursor),
          cursor: start,
        });
      }
      case 'd':
        return state.buffer.length === 0
          ? { state, action: { type: 'eof' } }
          : { state, action: NONE };
      default:
        return { state, action: NONE };
    }
  }
  if (key.meta === true) {
    // #5 — Alt/Meta word editing (emacs/readline parity), the standard muscle memory.
    switch (key.name) {
      case 'left':
      case 'b': // Alt-b — word left
        return keep({ cursor: wordLeft(state.buffer, state.cursor) });
      case 'right':
      case 'f': // Alt-f — word right
        return keep({ cursor: wordRight(state.buffer, state.cursor) });
      case 'backspace': {
        // Alt-Backspace — delete the word before the cursor (same as Ctrl-W).
        const start = wordLeft(state.buffer, state.cursor);
        return keep({
          buffer: state.buffer.slice(0, start) + state.buffer.slice(state.cursor),
          cursor: start,
        });
      }
      case 'd': {
        // Alt-d — delete the word AFTER the cursor.
        const end = wordRight(state.buffer, state.cursor);
        return keep({ buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(end) });
      }
      default:
        return { state, action: NONE };
    }
  }

  switch (key.name) {
    case 'return':
    case 'enter': {
      // D5 — deliberate multi-line: Shift+Enter (CSI-u/kitty terminals report the
      // modifier) inserts a newline at the cursor…
      if (key.shift === true) {
        return keep({
          buffer: state.buffer.slice(0, state.cursor) + '\n' + state.buffer.slice(state.cursor),
          cursor: state.cursor + 1,
        });
      }
      // …and a trailing backslash continues the line (portable everywhere): the
      // `\` is REPLACED by the newline. Only at the end of the buffer — a `\`
      // mid-text is content.
      if (state.buffer.endsWith('\\') && state.cursor === state.buffer.length) {
        const buffer = `${state.buffer.slice(0, -1)}\n`;
        return keep({ buffer, cursor: buffer.length });
      }
      const line = state.buffer;
      const history =
        line.length > 0 && state.history[0] !== line ? [line, ...state.history] : state.history;
      return {
        state: { ...state, buffer: '', cursor: 0, historyIndex: -1, draft: '', ghost: '', history },
        action: { type: 'submit', line },
      };
    }
    case 'tab':
      // Accept the ghost completion (append the dim suffix into the buffer).
      if (state.ghost.length > 0) {
        const buffer = state.buffer + state.ghost;
        return keep({ buffer, cursor: buffer.length, ghost: '' });
      }
      return { state, action: NONE };
    case 'backspace':
      if (state.cursor === 0) {
        return { state, action: NONE };
      }
      return keep({
        buffer: state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor),
        cursor: state.cursor - 1,
      });
    case 'delete':
      if (state.cursor >= state.buffer.length) {
        return { state, action: NONE };
      }
      return keep({
        buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1),
      });
    case 'left':
      // Cursor move keeps the (end-anchored) ghost.
      return {
        state: { ...state, cursor: clamp(state.cursor - 1, 0, state.buffer.length) },
        action: NONE,
      };
    case 'right':
      // → at the end of the buffer accepts the ghost; otherwise just moves right.
      if (state.cursor >= state.buffer.length && state.ghost.length > 0) {
        const buffer = state.buffer + state.ghost;
        return keep({ buffer, cursor: buffer.length, ghost: '' });
      }
      return {
        state: { ...state, cursor: clamp(state.cursor + 1, 0, state.buffer.length) },
        action: NONE,
      };
    case 'home':
      return keep({ cursor: 0 });
    case 'end':
      return keep({ cursor: state.buffer.length });
    case 'up':
      return historyPrev(state);
    case 'down':
      return historyNext(state);
    case 'escape':
      // A second consecutive ESC at the prompt (nothing typed between) opens the
      // rewind time-machine — Claude Code's Esc-Esc. The first ESC clears the
      // line and PRIMES the repeat; priming happens ONLY at the prompt, never on
      // a mid-turn confirm (mode === 'turn'). ESC must NEVER resolve null / exit.
      if (state.mode === 'prompt' && state.escapePrimed) {
        return {
          state: {
            ...state,
            buffer: '',
            cursor: 0,
            historyIndex: -1,
            draft: '',
            ghost: '',
            escapePrimed: false,
          },
          action: { type: 'rewind' },
        };
      }
      return {
        state: {
          ...state,
          buffer: '',
          cursor: 0,
          historyIndex: -1,
          draft: '',
          ghost: '',
          escapePrimed: state.mode === 'prompt',
        },
        action: NONE,
      };
    default:
      break;
  }

  // Printable insert (a single key, an emoji, or a pasted run of ASCII).
  if (isPrintableSeq(key.sequence)) {
    const seq = key.sequence;
    return keep({
      buffer: state.buffer.slice(0, state.cursor) + seq + state.buffer.slice(state.cursor),
      cursor: state.cursor + seq.length,
    });
  }
  return { state, action: NONE };
}

/** ↑ — recall an older history entry (saving the live draft on first step). */
function historyPrev(state: RawInputState): { state: RawInputState; action: RawAction } {
  if (state.history.length === 0 || state.historyIndex >= state.history.length - 1) {
    return { state, action: NONE };
  }
  const draft = state.historyIndex === -1 ? state.buffer : state.draft;
  const historyIndex = state.historyIndex + 1;
  const buffer = state.history[historyIndex] ?? '';
  return {
    state: { ...state, draft, historyIndex, buffer, cursor: buffer.length, ghost: '' },
    action: NONE,
  };
}

/** ↓ — move toward the live draft; past the newest entry restores the draft. */
function historyNext(state: RawInputState): { state: RawInputState; action: RawAction } {
  if (state.historyIndex === -1) {
    // ↓ on the EMPTY live line opens the Session Log (the down-into-history
    // gesture; the slot was a no-op). A non-empty draft keeps the no-op so a
    // half-typed prompt is never interrupted. Only at the prompt, never mid-turn.
    if (state.mode === 'prompt' && state.buffer.length === 0) {
      return { state, action: { type: 'open_log' } };
    }
    return { state, action: NONE };
  }
  const historyIndex = state.historyIndex - 1;
  const buffer = historyIndex === -1 ? state.draft : (state.history[historyIndex] ?? '');
  return {
    state: { ...state, historyIndex, buffer, cursor: buffer.length, ghost: '' },
    action: NONE,
  };
}

/**
 * Renders the prompt line for the current state: clear the line, write the
 * prompt + buffer, then move the cursor back over any text after the insertion
 * point. The prompt may carry ANSI color (zero-width) — the cursor-back count
 * is relative to the END of the buffer, so the prompt's width is irrelevant.
 */
/**
 * Instant, deterministic ghost (Slice 2a): completes a partial slash command.
 * `"/re"` against `["replay","review"]` ghosts `"play"` (first match by list
 * order). Returns '' when the buffer is not a single bare `/command` token (a
 * space/argument means the command is chosen; the model ghost handles the rest).
 */
export function instantGhost(buffer: string, commands: readonly string[]): string {
  if (!buffer.startsWith('/') || buffer.length < 2 || /\s/.test(buffer)) {
    return '';
  }
  const typed = buffer.slice(1);
  for (const command of commands) {
    if (command.length > typed.length && command.startsWith(typed)) {
      return command.slice(typed.length);
    }
  }
  return '';
}

export function renderInput(state: RawInputState, prompt: string): string {
  // Lay out: prompt + buffer + dim ghost, then move the cursor back over
  // everything after the insertion point (the post-cursor buffer + the ghost).
  // The prompt's ANSI color is zero-width, so the move count is buffer-relative.
  const ghost = state.ghost.length > 0 ? pc.dim(state.ghost) : '';
  const back = state.buffer.length - state.cursor + state.ghost.length;
  const moveBack = back > 0 ? `${ESC}[${back}D` : '';
  return `${CLEAR_LINE}${prompt}${state.buffer}${ghost}${moveBack}`;
}
