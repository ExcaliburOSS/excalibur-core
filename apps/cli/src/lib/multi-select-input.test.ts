import { describe, expect, it } from 'vitest';
import { reduceMultiSelectKey, type MultiSelectState } from './multi-select-input';
import type { ParsedKey } from './raw-input';

/**
 * The multi-select reducer is PURE — tested without a TTY by feeding synthetic
 * keys and asserting the next state + emitted action (mirrors select-input.test).
 */
const key = (k: Partial<ParsedKey>): ParsedKey => k;
const st = (index: number, selected: number[] = []): MultiSelectState => ({
  index,
  selected: new Set(selected),
});

describe('reduceMultiSelectKey (pure state machine)', () => {
  it('↓/↑ + j/k move and wrap', () => {
    expect(reduceMultiSelectKey(st(0), key({ name: 'down' }), 3).state.index).toBe(1);
    expect(reduceMultiSelectKey(st(2), key({ name: 'down' }), 3).state.index).toBe(0); // wrap
    expect(reduceMultiSelectKey(st(0), key({ name: 'up' }), 3).state.index).toBe(2); // wrap
    expect(reduceMultiSelectKey(st(0), key({ name: 'j' }), 3).state.index).toBe(1);
    expect(reduceMultiSelectKey(st(2), key({ name: 'k' }), 3).state.index).toBe(1);
    // Moving does NOT change the selection.
    expect([...reduceMultiSelectKey(st(0, [1]), key({ name: 'down' }), 3).state.selected]).toEqual([
      1,
    ]);
  });

  it('SPACE toggles the highlighted row independently', () => {
    const on = reduceMultiSelectKey(st(1), key({ sequence: ' ' }), 3);
    expect(on.action).toEqual({ type: 'toggle' });
    expect([...on.state.selected]).toEqual([1]);
    // Toggling an already-checked row turns it off (immutably — input untouched).
    const start = st(1, [1]);
    const off = reduceMultiSelectKey(start, key({ sequence: ' ' }), 3);
    expect([...off.state.selected]).toEqual([]);
    expect([...start.selected]).toEqual([1]); // original Set not mutated
  });

  it('`a` selects all, `n` selects none', () => {
    expect(
      [...reduceMultiSelectKey(st(0), key({ sequence: 'a' }), 3).state.selected].sort(),
    ).toEqual([0, 1, 2]);
    expect([
      ...reduceMultiSelectKey(st(0, [0, 2]), key({ sequence: 'n' }), 3).state.selected,
    ]).toEqual([]);
  });

  it('Enter SUBMITS the checked indices ascending (empty is a valid "none")', () => {
    expect(reduceMultiSelectKey(st(0, [2, 0]), key({ name: 'return' }), 3).action).toEqual({
      type: 'submit',
      selected: [0, 2],
    });
    expect(reduceMultiSelectKey(st(0, []), key({ name: 'return' }), 3).action).toEqual({
      type: 'submit',
      selected: [],
    });
  });

  it('Esc cancels, Ctrl-C sigints', () => {
    expect(reduceMultiSelectKey(st(0, [1]), key({ name: 'escape' }), 3).action).toEqual({
      type: 'cancel',
    });
    expect(reduceMultiSelectKey(st(0), key({ name: 'c', ctrl: true }), 3).action).toEqual({
      type: 'sigint',
    });
  });

  it('ignores an unrelated printable char (short lists have no type-ahead)', () => {
    expect(reduceMultiSelectKey(st(0), key({ name: 'z', sequence: 'z' }), 3).action).toEqual({
      type: 'none',
    });
  });
});
