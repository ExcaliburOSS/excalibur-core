/**
 * AO8-3 — autonomous SCHEDULING (the OSS analog of CC's ScheduleWakeup/cron):
 * persisted jobs that fire a task on a cadence (every N, or daily at HH:MM),
 * driven by a long-lived host (`excalibur schedule run` or the `serve` tick).
 *
 * This module is the PURE scheduling math — parse a human spec, compute the next
 * fire time, decide if a job is due, advance it after firing — with NO clock and
 * NO I/O (the caller passes `nowMs`), so it is exhaustively unit-testable. The
 * store + the daemon are layered on top.
 */

/** A recurrence: every `everyMs`, or daily at `minutesOfDay` minutes past midnight (local). */
export type ScheduleSpec =
  | { type: 'interval'; everyMs: number }
  | { type: 'dailyAt'; minutesOfDay: number };

export interface ScheduledJob {
  id: string;
  /** The task prompt to run when the job fires. */
  task: string;
  spec: ScheduleSpec;
  createdAtMs: number;
  /** When it last fired (epoch ms), or null if never. */
  lastRunMs: number | null;
  /** The next fire time (epoch ms). */
  nextRunMs: number;
  enabled: boolean;
}

const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Parses a duration like `90s` / `30m` / `2h` / `1d` into ms (null if invalid). */
export function parseDurationMs(text: string): number | null {
  const m = /^\s*(\d+)\s*(s|m|h|d)\s*$/i.exec(text);
  if (m === null) return null;
  const n = Number.parseInt(m[1] as string, 10);
  const unit = (m[2] as string).toLowerCase() as keyof typeof MS;
  const ms = n * MS[unit];
  return ms > 0 ? ms : null;
}

/** Parses a `HH:MM` (24h) time into minutes-past-midnight (null if invalid). */
export function parseTimeOfDay(text: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (m === null) return null;
  const h = Number.parseInt(m[1] as string, 10);
  const min = Number.parseInt(m[2] as string, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Parses a human schedule spec into a {@link ScheduleSpec} (null if invalid):
 *   - `every 30m` / `30m` / `2h` → interval
 *   - `at 14:30` / `daily 09:00` / `09:00` → daily-at
 */
export function parseScheduleSpec(text: string): ScheduleSpec | null {
  const t = text.trim().replace(/^(every|each|daily|at)\s+/i, '');
  const time = parseTimeOfDay(t);
  if (time !== null) return { type: 'dailyAt', minutesOfDay: time };
  const everyMs = parseDurationMs(t);
  if (everyMs !== null) return { type: 'interval', everyMs };
  return null;
}

/** The next fire time STRICTLY AFTER `fromMs` for a spec. */
export function nextRun(spec: ScheduleSpec, fromMs: number): number {
  if (spec.type === 'interval') {
    return fromMs + spec.everyMs;
  }
  // dailyAt: today at the target minute if it is still in the future, else tomorrow.
  const d = new Date(fromMs);
  const target = new Date(fromMs);
  target.setHours(Math.floor(spec.minutesOfDay / 60), spec.minutesOfDay % 60, 0, 0);
  if (target.getTime() <= d.getTime()) {
    target.setTime(target.getTime() + MS.d);
  }
  return target.getTime();
}

/** Whether a job should fire at `nowMs` (enabled + its next-run has arrived). */
export function isDue(job: ScheduledJob, nowMs: number): boolean {
  return job.enabled && nowMs >= job.nextRunMs;
}

/** Returns the enabled jobs due at `nowMs` (for the daemon tick). */
export function dueJobs(jobs: ReadonlyArray<ScheduledJob>, nowMs: number): ScheduledJob[] {
  return jobs.filter((j) => isDue(j, nowMs));
}

/** Advances a job after it fired at `nowMs`: stamps lastRun + computes the next fire. */
export function advanceJob(job: ScheduledJob, nowMs: number): ScheduledJob {
  return { ...job, lastRunMs: nowMs, nextRunMs: nextRun(job.spec, nowMs) };
}

/** A one-line human summary of a schedule (for `schedule list`). */
export function describeSpec(spec: ScheduleSpec): string {
  if (spec.type === 'interval') {
    const ms = spec.everyMs;
    const unit =
      ms % MS.d === 0
        ? `${ms / MS.d}d`
        : ms % MS.h === 0
          ? `${ms / MS.h}h`
          : ms % MS.m === 0
            ? `${ms / MS.m}m`
            : `${ms / MS.s}s`;
    return `every ${unit}`;
  }
  const h = Math.floor(spec.minutesOfDay / 60);
  const m = spec.minutesOfDay % 60;
  return `daily at ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
