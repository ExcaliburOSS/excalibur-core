import { describe, expect, it } from 'vitest';
import { windowActiveEvents, formatEarlier, ACTIVE_EVENT_WINDOW } from './rail-window.js';
import type { PhaseEvent } from './rail-types.js';

const ev = (text: string): PhaseEvent => ({ text });

describe('windowActiveEvents', () => {
  it('returns the full list unchanged when it fits the window', () => {
    const events = [ev('a'), ev('b'), ev('c')];
    const w = windowActiveEvents(events, 5);
    expect(w.hidden).toBe(0);
    expect(w.offset).toBe(0);
    expect(w.events.map((e) => e.text)).toEqual(['a', 'b', 'c']);
  });

  it('keeps only the most-recent tail and reports how many were hidden', () => {
    const events = Array.from({ length: 9 }, (_, i) => ev(`e${i}`));
    const w = windowActiveEvents(events, 5);
    expect(w.hidden).toBe(4);
    expect(w.offset).toBe(4);
    expect(w.events.map((e) => e.text)).toEqual(['e4', 'e5', 'e6', 'e7', 'e8']);
    // The most-recent event is always last (the in-progress action).
    expect(w.events[w.events.length - 1]!.text).toBe('e8');
  });

  it('defaults to ACTIVE_EVENT_WINDOW and never drops below a 1-event tail', () => {
    const events = Array.from({ length: 8 }, (_, i) => ev(`e${i}`));
    expect(windowActiveEvents(events).events).toHaveLength(ACTIVE_EVENT_WINDOW);
    expect(windowActiveEvents(events, 0).events).toHaveLength(1); // clamped to >= 1
  });
});

describe('formatEarlier', () => {
  it('substitutes the count into the default template', () => {
    expect(formatEarlier(4)).toBe('⋯ 4 earlier');
  });
  it('uses a localized template when provided', () => {
    expect(formatEarlier(3, '⋯ {count} anteriores')).toBe('⋯ 3 anteriores');
  });
});
