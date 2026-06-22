/**
 * The pure keystroke state machine for the arrow-key chooser (the interactive
 * upgrade to {@link Ui.select}).
 *
 * Like {@link reduceKey} in `raw-input.ts`, splitting the reducer + renderer
 * from `process.stdin`/`stdout` is what makes the chooser testable WITHOUT a TTY
 * (the sandbox/CI has none): feed synthetic {@link ParsedKey} events to
 * {@link reduceSelectKey} and assert the next index + the emitted
 * {@link SelectAction}; snapshot {@link renderChoiceLine}'s bytes. The thin I/O
 * shell in `ui.ts` wires Node's `keypress` events into this reducer, applies the
 * action, and repaints the list block in place.
 *
 * Navigation is BASIC and familiar (the user's words): ↑/↓ (and j/k) move the
 * highlight and wrap at the ends; Enter selects; a digit 1–9 jumps to that row
 * AND selects (so the old "type the number" muscle memory still works); Esc
 * cancels to the default; Ctrl-C aborts. The active row gets a cyan `❯` and bold
 * label; the rest are plain with a dim hint.
 */

import pc from 'picocolors';
import type { ParsedKey } from './raw-input';
import type { SelectChoice } from '../ui';
import { DEFAULT_SELECT_KEYMAP, selectActionFor, type SelectKeymap } from './keymap';

/** The chooser's mutable state — just the highlighted row. */
export interface SelectState {
  /** Zero-based index of the highlighted choice. */
  index: number;
}

/** What a keystroke asks the chooser shell to do. */
export type SelectAction =
  | { type: 'move' } // ↑/↓/j/k/digit moved the highlight → repaint
  | { type: 'submit'; index: number } // Enter (or a digit) chose a row
  | { type: 'cancel' } // Esc → resolve with the default index
  | { type: 'sigint' } // Ctrl-C → abort the process the same way the editor does
  | { type: 'none' };

/** Clamp/wrap a target index into `[0, count)` (wrap-around at both ends). */
function wrap(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return ((index % count) + count) % count;
}

/**
 * The pure reducer: given the current state, a decoded key, and the choice
 * count, return the next state and the action the shell must take. Never mutates
 * its input.
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
  // Resolve the key against the (possibly user-overridden) picker keymap.
  // selectActionFor already rejects modifier combos (single-key rule).
  switch (selectActionFor(key, keymap)) {
    case 'up':
      return { state: { index: wrap(state.index - 1, count) }, action: { type: 'move' } };
    case 'down':
      return { state: { index: wrap(state.index + 1, count) }, action: { type: 'move' } };
    case 'top':
      return { state: { index: 0 }, action: { type: 'move' } };
    case 'bottom':
      return { state: { index: Math.max(0, count - 1) }, action: { type: 'move' } };
    case 'accept':
      return { state, action: { type: 'submit', index: state.index } };
    case 'cancel':
      return { state, action: { type: 'cancel' } };
    default:
      break;
  }

  // A digit 1–9 jumps to that row AND selects it — preserving the old "type the
  // number, Enter" flow as a one-key shortcut (only when it names a real row).
  const digit =
    key.sequence !== undefined && /^[1-9]$/.test(key.sequence) ? Number(key.sequence) : 0;
  if (digit >= 1 && digit <= Math.min(9, count)) {
    return { state: { index: digit - 1 }, action: { type: 'submit', index: digit - 1 } };
  }

  return { state, action: { type: 'none' } };
}

/**
 * Renders ONE choice line for the list. The active row gets a cyan `❯` and a
 * bold label; inactive rows get two leading spaces. Hints render dim after the
 * label. The number is shown dim so the digit shortcut stays discoverable.
 */
export function renderChoiceLine(choice: SelectChoice, isActive: boolean, number: number): string {
  const marker = isActive ? pc.cyan('❯') : ' ';
  const num = pc.dim(`${number}.`);
  const label = isActive ? pc.bold(pc.cyan(choice.label)) : choice.label;
  const hint = choice.hint !== undefined && choice.hint.length > 0 ? ` ${pc.dim(choice.hint)}` : '';
  return `${marker} ${num} ${label}${hint}`;
}
