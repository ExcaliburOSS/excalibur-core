import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXCALIBUR_DIR } from '../config/load-config';
import type { ScheduledJob } from './schedule';

/**
 * AO8-3 — the on-disk store for scheduled jobs (`.excalibur/schedules.json`). A
 * tiny JSON-array store (the job count is small) with CRUD; the daemon reads it
 * each tick + writes back advanced jobs. Malformed/missing file → empty list.
 */
export class ScheduleStore {
  private readonly path: string;

  constructor(repoRoot: string) {
    this.path = join(repoRoot, EXCALIBUR_DIR, 'schedules.json');
  }

  /** All persisted jobs (empty on a missing/corrupt file — never throws on read). */
  list(): ScheduledJob[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter((j): j is ScheduledJob => isJob(j));
  }

  /** Overwrites the whole job set (used by the daemon to persist advanced jobs). */
  replaceAll(jobs: ReadonlyArray<ScheduledJob>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(jobs, null, 2), 'utf8');
  }

  /** Adds a job (returns the new full list). */
  add(job: ScheduledJob): ScheduledJob[] {
    const jobs = [...this.list(), job];
    this.replaceAll(jobs);
    return jobs;
  }

  /** Removes a job by id; returns true if one was removed. */
  remove(id: string): boolean {
    const jobs = this.list();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length) return false;
    this.replaceAll(next);
    return true;
  }

  /** Replaces a single job (by id) — e.g. after it fired/advanced. */
  update(job: ScheduledJob): void {
    this.replaceAll(this.list().map((j) => (j.id === job.id ? job : j)));
  }
}

/** Structural guard for a persisted job (tolerates hand-edits / older files). */
function isJob(v: unknown): v is ScheduledJob {
  if (typeof v !== 'object' || v === null) return false;
  const j = v as Record<string, unknown>;
  const spec = j['spec'];
  const specOk =
    typeof spec === 'object' &&
    spec !== null &&
    ((spec as { type?: unknown }).type === 'interval' ||
      (spec as { type?: unknown }).type === 'dailyAt');
  return (
    typeof j['id'] === 'string' &&
    typeof j['task'] === 'string' &&
    typeof j['nextRunMs'] === 'number' &&
    typeof j['enabled'] === 'boolean' &&
    specOk
  );
}
