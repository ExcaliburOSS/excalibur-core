import { join } from 'node:path';
import type { LocalRun, Locale, Translator } from '@excalibur/shared';
import { makeReportTranslator } from './report-catalog';
import { EXCALIBUR_DIR } from '../config/load-config';
import { listRecentCommits, type GitCommit } from '../git/git';
import { writeFileEnsured } from '../internal/fs-utils';
import type { RunManager } from '../runs/run-manager';
import { PatchStore, type LocalPatch } from '../stores/artifact-stores';

/**
 * Lightweight local Agentic Agile reports (AA-8, agentic-agile-core.md):
 * `excalibur daily` and `excalibur weekly-plan` summarize local git activity,
 * local runs and local patches as markdown — no enterprise scheduling.
 */

export interface ReportInput {
  repoRoot: string;
  runManager: RunManager;
  now?: Date;
  /**
   * Active chrome locale for the report prose (plan §"Idioma"). The CLI passes
   * `deps.locale`; core renders the report in en/es from its own catalog.
   * Defaults to `en`.
   */
  locale?: Locale;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO-8601 week number (weeks start Monday; week 1 contains January 4th). */
export function isoWeek(date: Date): { year: number; week: number } {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: target.getUTCFullYear(), week };
}

/** `daily-YYYY-MM-DD.md` (Build Contract §4.6). */
export function dailyReportFileName(now: Date = new Date()): string {
  return `daily-${isoDate(now)}.md`;
}

/** `weekly-plan-YYYY-Www.md` (Build Contract §4.6). */
export function weeklyPlanFileName(now: Date = new Date()): string {
  const { year, week } = isoWeek(now);
  return `weekly-plan-${year}-W${pad(week)}.md`;
}

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * The instant a finished run's work landed, for windowing reports. Uses
 * `completedAt` (when the work actually finished) — a run that STARTED before
 * the window but FINISHED inside it is this period's activity; one that started
 * inside the window but isn't done yet belongs to `pending`, not "completed
 * today". Falls back to `startedAt` only if a record somehow lacks completedAt.
 */
function finishedAt(run: LocalRun): Date {
  return new Date(run.record.completedAt ?? run.record.startedAt);
}

function describeRun(t: Translator, run: LocalRun): string {
  return t('report.run-line', {
    id: run.id,
    title: run.record.title,
    workflow: run.record.workflow,
    level: `L${run.record.autonomyLevel}`,
    status: run.record.status,
  });
}

function describePatch(t: Translator, patch: LocalPatch): string {
  return t('report.patch-line', {
    id: patch.id,
    command: patch.metadata.command,
    workflow: patch.metadata.workflow ?? t('report.no-workflow'),
    status: patch.metadata.status,
  });
}

function describeCommit(t: Translator, commit: GitCommit): string {
  return t('report.commit-line', {
    hash: commit.hash.slice(0, 7),
    subject: commit.subject,
    author: commit.author,
  });
}

function section(title: string, lines: string[], emptyText: string): string {
  const body = lines.length > 0 ? lines.join('\n') : `_${emptyText}_`;
  return `## ${title}\n\n${body}`;
}

const PENDING_STATUSES = new Set(['queued', 'running', 'waiting_approval']);

/**
 * Markdown daily report: today's completed/failed runs, patches, recent
 * commits and the pending items that still need attention.
 */
export function generateDailyReport(input: ReportInput): string {
  const now = input.now ?? new Date();
  const since = startOfDay(now);
  const sinceIso = since.toISOString();

  const runs = input.runManager.listRuns();
  // Completed/failed runs are windowed by when they FINISHED, not when they
  // started (a run that finished today but began yesterday still counts today).
  const completed = runs.filter(
    (run) => run.record.status === 'completed' && finishedAt(run) >= since,
  );
  const failed = runs.filter(
    (run) => run.record.status === 'failed' && finishedAt(run) >= since,
  );
  const pending = runs.filter((run) => PENDING_STATUSES.has(run.record.status));

  const patches = new PatchStore(input.repoRoot)
    .list()
    .filter((patch) => new Date(patch.metadata.createdAt) >= since);

  const commits = listRecentCommits(input.repoRoot, sinceIso);
  const t = makeReportTranslator(input.locale);

  return [
    t('report.daily-title', { date: isoDate(now) }),
    '',
    section(t('report.completed-runs'), completed.map((r) => describeRun(t, r)), t('report.no-completed-today')),
    '',
    section(t('report.failed-runs'), failed.map((r) => describeRun(t, r)), t('report.no-failed-today')),
    '',
    section(t('report.patches'), patches.map((p) => describePatch(t, p)), t('report.no-patches-today')),
    '',
    section(t('report.commits'), commits.map((c) => describeCommit(t, c)), t('report.no-commits-today')),
    '',
    section(t('report.pending'), pending.map((r) => describeRun(t, r)), t('report.nothing-pending')),
    '',
  ].join('\n');
}

/**
 * Markdown weekly plan: last week's activity plus a lightweight plan derived
 * from pending runs, failed runs and open patches. Facilitation only — it
 * never imposes an agile methodology.
 */
export function generateWeeklyPlan(input: ReportInput): string {
  const now = input.now ?? new Date();
  const { year, week } = isoWeek(now);
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  const runs = input.runManager.listRuns();
  // Window finished runs by completion time (see generateDailyReport).
  const completed = runs.filter(
    (run) => run.record.status === 'completed' && finishedAt(run) >= since,
  );
  const failed = runs.filter(
    (run) => run.record.status === 'failed' && finishedAt(run) >= since,
  );
  const pending = runs.filter((run) => PENDING_STATUSES.has(run.record.status));

  const allPatches = new PatchStore(input.repoRoot).list();
  const openPatches = allPatches.filter((patch) => patch.metadata.status === 'proposed');

  const commits = listRecentCommits(input.repoRoot, sinceIso);

  const t = makeReportTranslator(input.locale);
  const planLines: string[] = [];
  for (const run of pending) {
    planLines.push(t('report.plan-resume', { id: run.id, title: run.record.title, status: run.record.status }));
  }
  for (const run of failed) {
    planLines.push(t('report.plan-revisit', { id: run.id, title: run.record.title }));
  }
  for (const patch of openPatches) {
    planLines.push(t('report.plan-review-patch', { id: patch.id }));
  }

  return [
    t('report.weekly-title', { week: `${year}-W${pad(week)}` }),
    '',
    section(
      t('report.last-week'),
      [
        t('report.runs-summary', {
          total: completed.length + failed.length,
          completed: completed.length,
          failed: failed.length,
        }),
        t('report.commits-summary', { count: commits.length }),
        t('report.patches-summary', { total: allPatches.length, open: openPatches.length }),
      ],
      t('report.no-activity'),
    ),
    '',
    section(t('report.completed-runs'), completed.map((r) => describeRun(t, r)), t('report.no-completed-week')),
    '',
    section(t('report.plan-next-week'), planLines, t('report.nothing-carried')),
    '',
  ].join('\n');
}

/**
 * Writes a report into `.excalibur/reports/<fileName>`; returns the absolute
 * path of the written file.
 */
export function writeReport(repoRoot: string, fileName: string, markdown: string): string {
  const filePath = join(repoRoot, EXCALIBUR_DIR, 'reports', fileName);
  writeFileEnsured(filePath, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  return filePath;
}
