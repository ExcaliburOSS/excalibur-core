/**
 * The pure keystroke state machine for the arrow-key chooser (the interactive
 * upgrade to {@link Ui.select}).
 *
 * Like {@link reduceKey} in `raw-input.ts`, splitting the reducer + renderer from
 * `process.stdin`/`stdout` is what makes the chooser testable WITHOUT a TTY (the
 * sandbox/CI has none): feed synthetic {@link ParsedKey} events to
 * {@link reduceSelectKey} and assert the next state + the emitted
 * {@link SelectAction}; the thin I/O shell in `ui.ts` computes the filtered list,
 * picks a visible window via {@link computeWindow}, and repaints it in place.
 *
 * Interaction (fzf-style, optimized for long lists):
 *   - the {@link SelectKeymap} takes precedence — its keys move/accept/cancel
 *     (defaults: ↑/↓ + j/k, Home/End, Tab, Enter, Esc), and user letter-rebinds
 *     keep working;
 *   - any OTHER printable character filters the list (type-ahead). Matching is
 *     substring, so every provider is reachable by a distinctive substring that
 *     avoids the nav letters (e.g. "deep" → DeepSeek without typing the k);
 *     Backspace edits the filter; Esc clears the filter first, then cancels;
 *   - Enter selects the highlighted (filtered) row; a digit 1–9 jumps-and-selects
 *     ONLY when there is no active filter and the list is short (≤9), preserving
 *     the old muscle memory; Ctrl-C aborts.
 *
 * `index` is always relative to the FILTERED list; the shell maps it back to the
 * original choice index on submit.
 */

import pc from 'picocolors';
import type { ParsedKey } from './raw-input';
import type { SelectChoice } from '../ui';
import { DEFAULT_SELECT_KEYMAP, selectActionFor, type SelectKeymap } from './keymap';

/** The chooser's mutable state: highlighted row (in the filtered list) + filter. */
export interface SelectState {
  /** Zero-based index of the highlighted choice within the FILTERED list. */
  index: number;
  /** The active type-ahead filter query (lowercased matching is the shell's job). */
  query: string;
}

/** What a keystroke asks the chooser shell to do. */
export type SelectAction =
  | { type: 'move' } // highlight moved → repaint
  | { type: 'filter' } // query changed → recompute the filtered list + repaint
  | { type: 'submit'; index: number } // chose a row (index into the FILTERED list)
  | { type: 'cancel' } // Esc with no filter → resolve with the default index
  | { type: 'sigint' } // Ctrl-C → abort the process the same way the editor does
  | { type: 'none' };

/** Clamp/wrap a target index into `[0, count)` (wrap-around at both ends). */
function wrap(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return ((index % count) + count) % count;
}

/** The single printable character a key types (from its byte sequence), or null. */
function printableChar(key: ParsedKey): string | null {
  const seq = key.sequence;
  if (seq === undefined || seq.length !== 1) {
    return null;
  }
  const code = seq.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f ? seq : null;
}

/**
 * The visible window `[start, end)` over `total` rows that keeps `active` on
 * screen, showing at most `max` rows (centered-ish, clamped to the ends). When
 * everything fits, returns the whole range.
 */
export function computeWindow(
  active: number,
  total: number,
  max: number,
): { start: number; end: number } {
  if (max <= 0 || total <= max) {
    return { start: 0, end: total };
  }
  let start = active - Math.floor(max / 2);
  if (start < 0) {
    start = 0;
  }
  if (start + max > total) {
    start = total - max;
  }
  return { start, end: start + max };
}

/**
 * The pure reducer: given the current state, a decoded key, the FILTERED choice
 * count, and the picker keymap, return the next state and the action the shell
 * must take. Never mutates its input.
 */
export function reduceSelectKey(
  state: SelectState,
  key: ParsedKey,
  count: number,
  keymap: SelectKeymap = DEFAULT_SELECT_KEYMAP,
): { state: SelectState; action: SelectAction } {
  if (key.ctrl === true && key.name === 'c') {
    return { state, action: { type: 'sigint' } };
  }

  // The keymap wins first: special keys + any user letter-rebinds drive
  // navigation/accept/cancel. Only keys NOT bound here fall through to the
  // type-ahead filter below.
  switch (selectActionFor(key, keymap)) {
    case 'up':
      return { state: { ...state, index: wrap(state.index - 1, count) }, action: { type: 'move' } };
    case 'down':
      return { state: { ...state, index: wrap(state.index + 1, count) }, action: { type: 'move' } };
    case 'top':
      return { state: { ...state, index: 0 }, action: { type: 'move' } };
    case 'bottom':
      return { state: { ...state, index: Math.max(0, count - 1) }, action: { type: 'move' } };
    case 'accept':
      return count > 0
        ? { state, action: { type: 'submit', index: state.index } }
        : { state, action: { type: 'none' } };
    case 'cancel':
      // Esc clears the filter first; a second Esc (no filter) cancels.
      return state.query.length > 0
        ? { state: { index: 0, query: '' }, action: { type: 'filter' } }
        : { state, action: { type: 'cancel' } };
    default:
      break;
  }

  if (key.name === 'backspace') {
    return state.query.length > 0
      ? { state: { index: 0, query: state.query.slice(0, -1) }, action: { type: 'filter' } }
      : { state, action: { type: 'none' } };
  }

  const ch = printableChar(key);
  if (ch === null) {
    return { state, action: { type: 'none' } };
  }

  // A digit 1–9 jumps to that row AND selects it — but ONLY with no active
  // filter and a short list, so digits stay usable as filter chars on long lists.
  if (state.query.length === 0 && /^[1-9]$/.test(ch) && Number(ch) <= Math.min(9, count)) {
    const idx = Number(ch) - 1;
    return { state: { ...state, index: idx }, action: { type: 'submit', index: idx } };
  }

  // Any other printable char extends the type-ahead filter (highlight → top).
  return { state: { index: 0, query: state.query + ch }, action: { type: 'filter' } };
}

/**
 * Renders ONE choice line for the list. The active row gets a cyan `❯` and a
 * bold label; inactive rows get a leading space. Hints render dim after the
 * label. `number` is the row's 1-based position (dim) for the digit shortcut.
 */
export function renderChoiceLine(choice: SelectChoice, isActive: boolean, number: number): string {
  const marker = isActive ? pc.cyan('❯') : ' ';
  const num = pc.dim(`${number}.`);
  const label = isActive ? pc.bold(pc.cyan(choice.label)) : choice.label;
  const hint = choice.hint !== undefined && choice.hint.length > 0 ? ` ${pc.dim(choice.hint)}` : '';
  return `${marker} ${num} ${label}${hint}`;
}
