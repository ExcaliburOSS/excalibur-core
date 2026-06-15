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
}

/** What a keystroke asks the shell to do. */
export type RawAction =
  | { type: 'submit'; line: string } // Enter at the prompt → resolve question()
  | { type: 'abort' } // ESC while a turn is in flight → cancel it
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
    mode: 'prompt',
    awaiting: false,
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

/**
 * The pure reducer: given the current state and a decoded key, return the next
 * state and the action the shell must take. Never mutates its input.
 */
export function reduceKey(state: RawInputState, key: ParsedKey): { state: RawInputState; action: RawAction } {
  const keep = (next: Partial<RawInputState>): { state: RawInputState; action: RawAction } => ({
    state: { ...state, ...next },
    action: NONE,
  });

  // Ctrl-C is the SIGINT path always (under raw mode it arrives as a key).
  if (key.ctrl === true && key.name === 'c') {
    return { state, action: { type: 'sigint' } };
  }

  // --- not reading a line: a turn is running with just the spinner. ESC cancels
  // it; everything else is ignored (Slice 3 will QUEUE typed input here). ---
  if (!state.awaiting) {
    if (state.mode === 'turn' && key.name === 'escape' && key.ctrl !== true && key.meta !== true) {
      return { state, action: { type: 'abort' } };
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
      case 'd':
        return state.buffer.length === 0
          ? { state, action: { type: 'eof' } }
          : { state, action: NONE };
      default:
        return { state, action: NONE };
    }
  }
  if (key.meta === true) {
    return { state, action: NONE }; // Alt-combos: no-op in Slice 1
  }

  switch (key.name) {
    case 'return':
    case 'enter': {
      const line = state.buffer;
      const history =
        line.length > 0 && state.history[0] !== line ? [line, ...state.history] : state.history;
      return {
        state: { ...state, buffer: '', cursor: 0, historyIndex: -1, draft: '', history },
        action: { type: 'submit', line },
      };
    }
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
      return keep({ cursor: clamp(state.cursor - 1, 0, state.buffer.length) });
    case 'right':
      return keep({ cursor: clamp(state.cursor + 1, 0, state.buffer.length) });
    case 'home':
      return keep({ cursor: 0 });
    case 'end':
      return keep({ cursor: state.buffer.length });
    case 'up':
      return historyPrev(state);
    case 'down':
      return historyNext(state);
    case 'escape':
      // At the prompt, ESC clears the line (it must NEVER resolve null / exit).
      return keep({ buffer: '', cursor: 0, historyIndex: -1, draft: '' });
    case 'tab':
      return { state, action: NONE }; // ghost accept lands in Slice 2
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
  return { state: { ...state, draft, historyIndex, buffer, cursor: buffer.length }, action: NONE };
}

/** ↓ — move toward the live draft; past the newest entry restores the draft. */
function historyNext(state: RawInputState): { state: RawInputState; action: RawAction } {
  if (state.historyIndex === -1) {
    return { state, action: NONE };
  }
  const historyIndex = state.historyIndex - 1;
  const buffer = historyIndex === -1 ? state.draft : state.history[historyIndex] ?? '';
  return { state: { ...state, historyIndex, buffer, cursor: buffer.length }, action: NONE };
}

/**
 * Renders the prompt line for the current state: clear the line, write the
 * prompt + buffer, then move the cursor back over any text after the insertion
 * point. The prompt may carry ANSI color (zero-width) — the cursor-back count
 * is relative to the END of the buffer, so the prompt's width is irrelevant.
 */
export function renderInput(state: RawInputState, prompt: string): string {
  const back = state.buffer.length - state.cursor;
  const moveBack = back > 0 ? `${ESC}[${back}D` : '';
  return `${CLEAR_LINE}${prompt}${state.buffer}${moveBack}`;
}
