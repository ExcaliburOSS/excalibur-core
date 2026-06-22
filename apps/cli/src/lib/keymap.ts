import type { ParsedKey } from './raw-input';

/**
 * Config-driven keybindings for the interactive list picker (P1.13b).
 *
 * The picker (`reduceSelectKey`) is the clean, self-contained input surface where
 * rebinding is safe — unlike the REPL line editor, whose keys are standard +
 * context-sensitive (history nav, ghost-accept, Esc-Esc) and deliberately stay
 * fixed. A `SelectKeymap` maps each picker ACTION to the set of single keys that
 * trigger it; `config.keybindings.select` overrides per-action (FIRM: single keys
 * only — never modifier combos). Pure + TTY-free → unit-tested.
 */

export interface SelectKeymap {
  up: string[];
  down: string[];
  top: string[];
  bottom: string[];
  accept: string[];
  cancel: string[];
}

export type SelectActionName = keyof SelectKeymap;

/** The built-in bindings (the familiar arrow/jk/Enter/Esc set). */
export const DEFAULT_SELECT_KEYMAP: SelectKeymap = {
  up: ['up', 'k'],
  down: ['down', 'j', 'tab'],
  top: ['home'],
  bottom: ['end'],
  accept: ['return', 'enter'],
  cancel: ['escape'],
};

const ACTIONS: SelectActionName[] = ['up', 'down', 'top', 'bottom', 'accept', 'cancel'];

/** A single, non-modifier key name (special name or single printable char). */
const SINGLE_KEY =
  /^(?:[\x20-\x7e]|up|down|left|right|home|end|return|enter|escape|tab|space|backspace|delete|pageup|pagedown)$/i;

/** True for a valid single-key binding string (rejects empty + modifier combos like "ctrl+a"). */
export function isSingleKey(value: string): boolean {
  return value.length > 0 && !value.includes('+') && SINGLE_KEY.test(value);
}

/**
 * Builds the effective picker keymap by merging `overrides` over the defaults
 * PER ACTION (a specified action replaces its default keys; unspecified actions
 * keep theirs). Invalid (non-single-key / empty) bindings are dropped so a typo
 * never disables a default action's keys entirely (the action keeps its default).
 */
export function resolveSelectKeymap(
  overrides?: Partial<Record<SelectActionName, string | string[]>>,
): SelectKeymap {
  if (overrides === undefined) {
    return DEFAULT_SELECT_KEYMAP;
  }
  const result: SelectKeymap = { ...DEFAULT_SELECT_KEYMAP };
  for (const action of ACTIONS) {
    const raw = overrides[action];
    if (raw === undefined) {
      continue;
    }
    const keys = (Array.isArray(raw) ? raw : [raw])
      .map((k) => k.toLowerCase())
      .filter((k) => isSingleKey(k));
    if (keys.length > 0) {
      result[action] = keys;
    }
  }
  return result;
}

/** Resolves a decoded key to the picker action it triggers, or null. */
export function selectActionFor(key: ParsedKey, keymap: SelectKeymap): SelectActionName | null {
  // Modifier combos never trigger a picker action (single-key rule); Ctrl-C is
  // handled separately by the reducer as sigint.
  if (key.ctrl === true || key.meta === true) {
    return null;
  }
  const candidates: string[] = [];
  if (typeof key.name === 'string' && key.name.length > 0) {
    candidates.push(key.name.toLowerCase());
  }
  if (typeof key.sequence === 'string' && key.sequence.length === 1) {
    candidates.push(key.sequence.toLowerCase());
  }
  for (const action of ACTIONS) {
    if (keymap[action].some((k) => candidates.includes(k))) {
      return action;
    }
  }
  return null;
}
