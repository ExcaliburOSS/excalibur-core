import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECT_KEYMAP, isSingleKey, resolveSelectKeymap, selectActionFor } from './keymap';

/** P1.13b — config-driven picker keybindings. */

describe('isSingleKey', () => {
  it('accepts single chars and known key names', () => {
    for (const k of ['j', 'k', '1', 'up', 'down', 'tab', 'escape', 'return', 'home', ' ']) {
      expect(isSingleKey(k), k).toBe(true);
    }
  });
  it('rejects empty, modifier combos and multi-char garbage', () => {
    for (const k of ['', 'ctrl+a', 'cmd+k', 'shift+tab', 'wat', 'ab']) {
      expect(isSingleKey(k), k).toBe(false);
    }
  });
});

describe('resolveSelectKeymap', () => {
  it('returns the defaults when there are no overrides', () => {
    expect(resolveSelectKeymap()).toBe(DEFAULT_SELECT_KEYMAP);
  });

  it('overrides a single action (string), keeping the rest default', () => {
    const km = resolveSelectKeymap({ accept: 'l' });
    expect(km.accept).toEqual(['l']);
    expect(km.up).toEqual(DEFAULT_SELECT_KEYMAP.up); // untouched
  });

  it('accepts a list of keys for an action', () => {
    const km = resolveSelectKeymap({ down: ['s', 'down'] });
    expect(km.down).toEqual(['s', 'down']);
  });

  it('drops invalid (modifier-combo / empty) bindings, keeping the default for that action', () => {
    const km = resolveSelectKeymap({ up: 'ctrl+p', down: ['', 'ctrl+n'] });
    expect(km.up).toEqual(DEFAULT_SELECT_KEYMAP.up); // 'ctrl+p' dropped → default
    expect(km.down).toEqual(DEFAULT_SELECT_KEYMAP.down); // all dropped → default
  });
});

describe('selectActionFor', () => {
  it('maps the default keys to actions', () => {
    expect(selectActionFor({ name: 'up' }, DEFAULT_SELECT_KEYMAP)).toBe('up');
    expect(selectActionFor({ name: 'k' }, DEFAULT_SELECT_KEYMAP)).toBe('up');
    expect(selectActionFor({ name: 'tab' }, DEFAULT_SELECT_KEYMAP)).toBe('down');
    expect(selectActionFor({ name: 'return' }, DEFAULT_SELECT_KEYMAP)).toBe('accept');
    expect(selectActionFor({ name: 'escape' }, DEFAULT_SELECT_KEYMAP)).toBe('cancel');
  });

  it('honors a custom binding (by sequence char)', () => {
    const km = resolveSelectKeymap({ accept: 'l', cancel: 'q' });
    expect(selectActionFor({ name: 'l', sequence: 'l' }, km)).toBe('accept');
    expect(selectActionFor({ sequence: 'q' }, km)).toBe('cancel');
  });

  it('never triggers an action for a modifier combo (single-key rule)', () => {
    expect(selectActionFor({ name: 'up', ctrl: true }, DEFAULT_SELECT_KEYMAP)).toBeNull();
    expect(selectActionFor({ name: 'k', meta: true }, DEFAULT_SELECT_KEYMAP)).toBeNull();
  });

  it('returns null for an unmapped key', () => {
    expect(selectActionFor({ name: 'x', sequence: 'x' }, DEFAULT_SELECT_KEYMAP)).toBeNull();
  });
});
