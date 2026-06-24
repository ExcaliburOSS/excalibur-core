import { describe, expect, it } from 'vitest';
import { selectWinner, type ExploreCandidate } from './explore';

const cand = (id: string, diff: string, failed = false): ExploreCandidate => ({
  id,
  approach: id,
  diff,
  failed,
});

describe('selectWinner (AO5 best-of-N, pure)', () => {
  const three = [cand('a', '+a'), cand('b', '+b'), cand('c', '+c')];

  it('picks the judge-chosen 1-based candidate', () => {
    expect(selectWinner(three, 'Candidate 2 is best')).toBe(1);
    expect(selectWinner(three, '3')).toBe(2);
  });

  it('falls back to the first usable candidate on an unparseable/out-of-range reply', () => {
    expect(selectWinner(three, 'they are all fine')).toBe(0);
    expect(selectWinner(three, '9')).toBe(0);
  });

  it('never picks a failed or empty candidate', () => {
    const mixed = [cand('a', '', false), cand('b', '+b'), cand('c', '+c', true)];
    // Judge says 1 (empty) and 3 (failed) — both unusable → first USABLE is index 1.
    expect(selectWinner(mixed, '1')).toBe(1);
    expect(selectWinner(mixed, '3')).toBe(1);
    expect(selectWinner(mixed, '2')).toBe(1);
  });

  it('returns -1 when no candidate is usable', () => {
    expect(selectWinner([cand('a', '', true), cand('b', '   ')], '1')).toBe(-1);
  });
});
