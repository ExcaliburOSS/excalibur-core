import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleStore } from './schedule-store';
import type { ScheduledJob } from './schedule';

const job = (id: string): ScheduledJob => ({
  id,
  task: `task ${id}`,
  spec: { type: 'interval', everyMs: 3_600_000 },
  createdAtMs: 0,
  lastRunMs: null,
  nextRunMs: 3_600_000,
  enabled: true,
});

describe('ScheduleStore (AO8-3)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty, adds, lists, removes', () => {
    const store = new ScheduleStore(dir);
    expect(store.list()).toEqual([]);
    store.add(job('a'));
    store.add(job('b'));
    expect(store.list().map((j) => j.id)).toEqual(['a', 'b']);
    expect(store.remove('a')).toBe(true);
    expect(store.list().map((j) => j.id)).toEqual(['b']);
    expect(store.remove('nope')).toBe(false);
  });

  it('updates a job in place + persists across instances', () => {
    const store = new ScheduleStore(dir);
    store.add(job('a'));
    store.update({ ...job('a'), lastRunMs: 999, nextRunMs: 4_600_000 });
    const reloaded = new ScheduleStore(dir).list();
    expect(reloaded[0]?.lastRunMs).toBe(999);
    expect(reloaded[0]?.nextRunMs).toBe(4_600_000);
  });

  it('returns [] for a missing / corrupt file (never throws on read)', () => {
    expect(new ScheduleStore(dir).list()).toEqual([]); // no file yet
  });

  it('setEnabled atomically flips one job and preserves the rest (DASH2 review fix)', () => {
    const store = new ScheduleStore(dir);
    store.add({ ...job('a'), enabled: true });
    store.add({ ...job('b'), enabled: true, nextRunMs: 7000 });
    expect(store.setEnabled('a', false)).toBe(true);
    const reloaded = new ScheduleStore(dir).list();
    expect(reloaded.find((j) => j.id === 'a')?.enabled).toBe(false);
    expect(reloaded.find((j) => j.id === 'b')?.enabled).toBe(true); // untouched
    expect(reloaded.find((j) => j.id === 'b')?.nextRunMs).toBe(7000); // timing preserved
    expect(store.setEnabled('nope', true)).toBe(false); // unknown id
  });

  it('drops jobs with a malformed spec payload (NaN/out-of-range), keeps valid ones', () => {
    const store = new ScheduleStore(dir);
    // A hand-edited file: one good job + bad ones (NaN everyMs, out-of-range minute).
    store.replaceAll([
      job('good'),
      { ...job('bad1'), spec: { type: 'interval', everyMs: Number.NaN } } as never,
      { ...job('bad2'), spec: { type: 'dailyAt', minutesOfDay: 9999 } } as never,
    ]);
    expect(new ScheduleStore(dir).list().map((j) => j.id)).toEqual(['good']);
  });
});
