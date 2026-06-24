import { describe, expect, it } from 'vitest';
import {
  advanceJob,
  describeSpec,
  dueJobs,
  isDue,
  nextRun,
  parseDurationMs,
  parseScheduleSpec,
  parseTimeOfDay,
  type ScheduledJob,
} from './schedule';

describe('parseDurationMs', () => {
  it('parses s/m/h/d units, rejects junk + zero', () => {
    expect(parseDurationMs('90s')).toBe(90_000);
    expect(parseDurationMs('30m')).toBe(1_800_000);
    expect(parseDurationMs('2h')).toBe(7_200_000);
    expect(parseDurationMs('1d')).toBe(86_400_000);
    expect(parseDurationMs('0m')).toBeNull();
    expect(parseDurationMs('soon')).toBeNull();
  });
});

describe('parseTimeOfDay', () => {
  it('parses HH:MM and rejects out-of-range', () => {
    expect(parseTimeOfDay('09:30')).toBe(570);
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('23:59')).toBe(1439);
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('9:60')).toBeNull();
    expect(parseTimeOfDay('nope')).toBeNull();
  });
});

describe('parseScheduleSpec', () => {
  it('parses interval + daily-at forms (with optional lead words)', () => {
    expect(parseScheduleSpec('every 30m')).toEqual({ type: 'interval', everyMs: 1_800_000 });
    expect(parseScheduleSpec('2h')).toEqual({ type: 'interval', everyMs: 7_200_000 });
    expect(parseScheduleSpec('at 14:30')).toEqual({ type: 'dailyAt', minutesOfDay: 870 });
    expect(parseScheduleSpec('daily 09:00')).toEqual({ type: 'dailyAt', minutesOfDay: 540 });
    expect(parseScheduleSpec('whenever')).toBeNull();
  });
});

describe('nextRun', () => {
  it('interval advances by everyMs', () => {
    expect(nextRun({ type: 'interval', everyMs: 1000 }, 5000)).toBe(6000);
  });
  it('dailyAt picks today if future, tomorrow if past', () => {
    // 2026-06-24T08:00 local
    const at09 = { type: 'dailyAt' as const, minutesOfDay: 9 * 60 };
    const morning = new Date(2026, 5, 24, 8, 0, 0, 0).getTime();
    expect(nextRun(at09, morning)).toBe(new Date(2026, 5, 24, 9, 0, 0, 0).getTime()); // today 09:00
    const afternoon = new Date(2026, 5, 24, 15, 0, 0, 0).getTime();
    expect(nextRun(at09, afternoon)).toBe(new Date(2026, 5, 25, 9, 0, 0, 0).getTime()); // tomorrow 09:00
  });
});

describe('isDue / dueJobs / advanceJob', () => {
  const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
    id: 'j1',
    task: 'run the tests',
    spec: { type: 'interval', everyMs: 1000 },
    createdAtMs: 0,
    lastRunMs: null,
    nextRunMs: 1000,
    enabled: true,
    ...over,
  });

  it('isDue only when enabled + the next-run has arrived', () => {
    expect(isDue(job({ nextRunMs: 1000 }), 999)).toBe(false);
    expect(isDue(job({ nextRunMs: 1000 }), 1000)).toBe(true);
    expect(isDue(job({ nextRunMs: 1000, enabled: false }), 5000)).toBe(false);
  });

  it('dueJobs filters the due ones', () => {
    const jobs = [job({ id: 'a', nextRunMs: 500 }), job({ id: 'b', nextRunMs: 5000 })];
    expect(dueJobs(jobs, 1000).map((j) => j.id)).toEqual(['a']);
  });

  it('advanceJob stamps lastRun + reschedules', () => {
    const advanced = advanceJob(job({ nextRunMs: 1000 }), 1000);
    expect(advanced.lastRunMs).toBe(1000);
    expect(advanced.nextRunMs).toBe(2000); // 1000 + everyMs(1000)
  });
});

describe('describeSpec', () => {
  it('summarizes interval + daily-at', () => {
    expect(describeSpec({ type: 'interval', everyMs: 1_800_000 })).toBe('every 30m');
    expect(describeSpec({ type: 'interval', everyMs: 7_200_000 })).toBe('every 2h');
    expect(describeSpec({ type: 'dailyAt', minutesOfDay: 540 })).toBe('daily at 09:00');
  });
});
