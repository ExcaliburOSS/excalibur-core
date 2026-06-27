import { describe, expect, it } from 'vitest';
import { computeBurndown, enumerateDays, type BurndownItem } from './burndown';

describe('enumerateDays', () => {
  it('lists each day inclusive', () => {
    expect(enumerateDays('2026-07-01', '2026-07-03')).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
  });
  it('is empty for an inverted or invalid range', () => {
    expect(enumerateDays('2026-07-03', '2026-07-01')).toEqual([]);
    expect(enumerateDays('nope', '2026-07-01')).toEqual([]);
  });
});

describe('computeBurndown', () => {
  it('falls the ideal line linearly to 0 and tracks actual remaining by done-date', () => {
    const items: BurndownItem[] = [
      { points: 3, doneDate: '2026-07-01' },
      { points: 2, doneDate: '2026-07-02' },
      { points: 5, doneDate: null }, // not done
    ];
    const b = computeBurndown('2026-07-01', '2026-07-03', items);
    expect(b.totalPoints).toBe(10);
    expect(b.donePoints).toBe(5);
    expect(b.itemCount).toBe(3);
    // Ideal: 10 → 5 → 0 across 3 days.
    expect(b.days.map((d) => d.ideal)).toEqual([10, 5, 0]);
    // Actual remaining: day1 −3 = 7, day2 −2 = 5, day3 = 5 (the 5pt item never finished).
    expect(b.days.map((d) => d.remaining)).toEqual([7, 5, 5]);
  });

  it('falls back to item-count points and only counts completion on/before each day', () => {
    const items: BurndownItem[] = [
      { points: 1, doneDate: '2026-07-02' },
      { points: 1, doneDate: null },
    ];
    const b = computeBurndown('2026-07-01', '2026-07-02', items);
    expect(b.totalPoints).toBe(2);
    // day1: nothing done yet → remaining 2; day2: one done → remaining 1.
    expect(b.days.map((d) => d.remaining)).toEqual([2, 1]);
  });

  it('handles an empty sprint window without throwing', () => {
    const b = computeBurndown('2026-07-03', '2026-07-01', [{ points: 5, doneDate: null }]);
    expect(b.days).toEqual([]);
    expect(b.totalPoints).toBe(5);
  });
});
