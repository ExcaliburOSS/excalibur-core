import { describe, expect, it } from 'vitest';
import { topologicalWaves } from './toposort';

const ids = (waves: { id: string }[][] | null) => waves?.map((w) => w.map((n) => n.id));

describe('topologicalWaves (AO3b, pure)', () => {
  it('puts all independent items in a single wave', () => {
    expect(ids(topologicalWaves([{ id: 'a' }, { id: 'b' }, { id: 'c' }]))).toEqual([
      ['a', 'b', 'c'],
    ]);
  });

  it('levelizes a chain A→B→C into three single-item waves', () => {
    const waves = topologicalWaves([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]);
    expect(ids(waves)).toEqual([['a'], ['b'], ['c']]);
  });

  it('schedules the classic A→{B,C}→D diamond', () => {
    const waves = topologicalWaves([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]);
    expect(ids(waves)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('preserves input order within a wave (stable)', () => {
    const waves = topologicalWaves([{ id: 'z' }, { id: 'y' }, { id: 'x', dependsOn: ['z', 'y'] }]);
    expect(ids(waves)).toEqual([['z', 'y'], ['x']]);
  });

  it('ignores a dangling dependency (id not in the set)', () => {
    expect(ids(topologicalWaves([{ id: 'a', dependsOn: ['ghost'] }, { id: 'b' }]))).toEqual([
      ['a', 'b'],
    ]);
  });

  it('ignores a self-dependency', () => {
    expect(ids(topologicalWaves([{ id: 'a', dependsOn: ['a'] }]))).toEqual([['a']]);
  });

  it('returns null on a cycle', () => {
    expect(
      topologicalWaves([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ]),
    ).toBeNull();
  });

  it('returns an empty list for no items', () => {
    expect(topologicalWaves([])).toEqual([]);
  });
});
