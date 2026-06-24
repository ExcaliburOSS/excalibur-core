/**
 * The pure keystroke state machine for the MULTI-select chooser (sibling to the
 * single-select {@link reduceSelectKey} in `select-input.ts`). Powers the
 * plan-shaping recommendation picker: the user toggles which related
 * developments to fold into the plan.
 *
 * Like `select-input.ts`, the reducer is split from `process.stdin/stdout` so it
 * is testable WITHOUT a TTY: feed synthetic {@link ParsedKey} events and assert
 * the next state + the emitted {@link MultiSelectAction}; the thin I/O shell in
 * `ui.ts` (`Ui.multiSelect`) repaints the list in place.
 *
 * Interaction (single-key rule — never modifier combos):
 *   - ↑/↓ + j/k (and Home/End) move the highlight (via the shared SelectKeymap);
 *   - SPACE toggles the highlighted row's checkbox;
 *   - `a` selects ALL, `n` selects NONE (quick bulk ops);
 *   - ENTER submits the current selection (possibly empty — that's a valid "none");
 *   - Esc cancels (the shell SKIPS — resolves with an empty set, adding nothing); Ctrl-C aborts.
 *
 * Lists are short (a handful of recommendations) so there is no type-ahead filter
 * — every printable char that isn't a bulk-op is ignored.
 */

import pc from 'picocolors';
import type { ParsedKey } from './raw-input';
import type { SelectChoice } from '../ui';
import { DEFAULT_SELECT_KEYMAP, selectActionFor, type SelectKeymap } from './keymap';

/** The chooser's mutable state: highlighted row + the set of checked indices. */
export interface MultiSelectState {
  /** Zero-based index of the highlighted row. */
  index: number;
  /** The set of checked choice indices. */
  selected: ReadonlySet<number>;
}

/** What a keystroke asks the multi-select shell to do. */
export type MultiSelectAction =
  | { type: 'move' } // highlight moved → repaint
  | { type: 'toggle' } // selection changed → repaint
  | { type: 'submit'; selected: number[] } // Enter → resolve with the checked indices (ascending)
  | { type: 'cancel' } // Esc → SKIP (the shell resolves with an empty set)
  | { type: 'sigint' } // Ctrl-C → abort
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

/** Toggles membership of `i` in `set`, returning a NEW set (never mutates). */
function toggleIndex(set: ReadonlySet<number>, i: number): Set<number> {
  const next = new Set(set);
  if (next.has(i)) {
    next.delete(i);
  } else {
    next.add(i);
  }
  return next;
}

/**
 * The pure reducer: given the current state, a decoded key, the choice count, and
 * the picker keymap, return the next state + the action the shell must take.
 * Never mutates its input.
 */
export function reduceMultiSelectKey(
  state: MultiSelectState,
  key: ParsedKey,
  count: number,
  keymap: SelectKeymap = DEFAULT_SELECT_KEYMAP,
): { state: MultiSelectState; action: MultiSelectAction } {
  if (key.ctrl === true && key.name === 'c') {
    return { state, action: { type: 'sigint' } };
  }

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
      return {
        state,
        action: { type: 'submit', selected: [...state.selected].sort((a, b) => a - b) },
      };
    case 'cancel':
      return { state, action: { type: 'cancel' } };
    default:
      break;
  }

  const ch = printableChar(key);
  if (ch === ' ' && count > 0) {
    return {
      state: { ...state, selected: toggleIndex(state.selected, state.index) },
      action: { type: 'toggle' },
    };
  }
  if (ch === 'a') {
    return {
      state: { ...state, selected: new Set(Array.from({ length: count }, (_, i) => i)) },
      action: { type: 'toggle' },
    };
  }
  if (ch === 'n') {
    return { state: { ...state, selected: new Set<number>() }, action: { type: 'toggle' } };
  }
  return { state, action: { type: 'none' } };
}

/**
 * Renders ONE row: a `❯` on the active row, a `◉`/`◻` checkbox for checked/
 * unchecked, the label (bold when active) and a dim hint. Pre-checked rows show a
 * filled box from the start so high-confidence recommendations read as "on".
 */
export function renderMultiChoiceLine(
  choice: SelectChoice,
  isActive: boolean,
  isSelected: boolean,
  ascii = false,
): string {
  const marker = isActive ? pc.cyan('❯') : ' ';
  const box = isSelected ? pc.green(ascii ? '[x]' : '◉') : pc.dim(ascii ? '[ ]' : '◻');
  const label = isActive ? pc.bold(choice.label) : choice.label;
  const hint = choice.hint !== undefined && choice.hint.length > 0 ? ` ${pc.dim(choice.hint)}` : '';
  return `${marker} ${box} ${label}${hint}`;
}
