import { describe, expect, it } from 'vitest';
import type { ChronogramDto, ChronogramLaneDto } from './contracts';
import { laneBarAt, laneStateAt, timeBounds } from './chronogram-time';

const lane = (over: Partial<ChronogramLaneDto>): ChronogramLaneDto => ({
  id: 't',
  title: 'T',
  instruction: '',
  wave: 0,
  dependsOn: [],
  state: 'done',
  runId: 'r',
  costCents: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
  ...over,
});

const T0 = '2026-06-24T00:00:00.000Z';
const T30 = '2026-06-24T00:00:30.000Z';
const T60 = '2026-06-24T00:01:00.000Z';
const at = (iso: string): number => Date.parse(iso);

describe('laneStateAt (AO6 Pillar 4 time-travel)', () => {
  const done = lane({ state: 'done', startedAt: T0, completedAt: T30 });

  it('pending before it started', () => {
    expect(laneStateAt(done, at(T0) - 1000)).toBe('pending');
  });
  it('running between start and completion', () => {
    expect(laneStateAt(done, at('2026-06-24T00:00:15.000Z'))).toBe('running');
  });
  it('its final state once completed', () => {
    expect(laneStateAt(done, at(T30))).toBe('done');
    expect(laneStateAt(done, at(T60))).toBe('done');
  });
  it('a not-yet-started lane is always pending', () => {
    expect(laneStateAt(lane({ state: 'pending', startedAt: null }), at(T60))).toBe('pending');
  });
  it('a still-running lane stays running after its start', () => {
    expect(laneStateAt(lane({ state: 'running', startedAt: T0, completedAt: null }), at(T60))).toBe(
      'running',
    );
  });
});

describe('timeBounds', () => {
  it('spans the earliest start to the latest end', () => {
    const c = {
      lanes: [
        lane({ startedAt: T0, completedAt: T30 }),
        lane({ id: 'u', startedAt: T30, completedAt: T60 }),
      ],
    } as unknown as ChronogramDto;
    const { t0, t1 } = timeBounds(c, at(T60));
    expect(t0).toBe(at(T0));
    expect(t1).toBe(at(T60));
  });
});

describe('laneBarAt', () => {
  it('clips the bar to the scrub head (no bar before start, partial mid-run)', () => {
    const l = lane({ startedAt: T0, completedAt: T60, state: 'done' });
    const t0 = at(T0);
    const t1 = at(T60);
    expect(laneBarAt(l, at(T0) - 1, t0, t1, t1).hasBar).toBe(false);
    const mid = laneBarAt(l, at(T30), t0, t1, t1);
    expect(mid.hasBar).toBe(true);
    expect(mid.left).toBeCloseTo(0, 5);
    expect(mid.width).toBeCloseTo(50, 0); // half the span elapsed
    const full = laneBarAt(l, at(T60), t0, t1, t1);
    expect(full.width).toBeCloseTo(100, 0);
  });
});
