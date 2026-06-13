import { join } from 'node:path';
import type { LocalRun } from '@excalibur/shared';
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

function describeRun(run: LocalRun): string {
  const level = `L${run.record.autonomyLevel}`;
  return `- ${run.id} — ${run.record.title} (${run.record.workflow}, ${level}) — ${run.record.status}`;
}

function describePatch(patch: LocalPatch): string {
  return `- ${patch.id} — ${patch.metadata.command} (${patch.metadata.workflow ?? 'no workflow'}) — ${patch.metadata.status}`;
}

function describeCommit(commit: GitCommit): string {
  return `- ${commit.hash.slice(0, 7)} ${commit.subject} (${commit.author})`;
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
  const todaysRuns = runs.filter((run) => new Date(run.record.startedAt) >= since);
  const completed = todaysRuns.filter((run) => run.record.status === 'completed');
  const failed = todaysRuns.filter((run) => run.record.status === 'failed');
  const pending = runs.filter((run) => PENDING_STATUSES.has(run.record.status));

  const patches = new PatchStore(input.repoRoot)
    .list()
    .filter((patch) => new Date(patch.metadata.createdAt) >= since);

  const commits = listRecentCommits(input.repoRoot, sinceIso);

  return [
    `# Daily Report — ${isoDate(now)}`,
    '',
    section('Completed runs', completed.map(describeRun), 'No completed runs today.'),
    '',
    section('Failed runs', failed.map(describeRun), 'No failed runs today.'),
    '',
    section('Patches', patches.map(describePatch), 'No patches generated today.'),
    '',
    section('Commits', commits.map(describeCommit), 'No commits today.'),
    '',
    section('Pending', pending.map(describeRun), 'Nothing pending.'),
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
  const weekRuns = runs.filter((run) => new Date(run.record.startedAt) >= since);
  const completed = weekRuns.filter((run) => run.record.status === 'completed');
  const failed = weekRuns.filter((run) => run.record.status === 'failed');
  const pending = runs.filter((run) => PENDING_STATUSES.has(run.record.status));

  const allPatches = new PatchStore(input.repoRoot).list();
  const openPatches = allPatches.filter((patch) => patch.metadata.status === 'proposed');

  const commits = listRecentCommits(input.repoRoot, sinceIso);

  const planLines: string[] = [];
  for (const run of pending) {
    planLines.push(`- Resume ${run.id} — ${run.record.title} (${run.record.status}).`);
  }
  for (const run of failed) {
    planLines.push(`- Revisit failed run ${run.id} — ${run.record.title}.`);
  }
  for (const patch of openPatches) {
    planLines.push(`- Review and apply (or reject) patch ${patch.id}.`);
  }

  return [
    `# Weekly Plan — ${year}-W${pad(week)}`,
    '',
    section(
      'Last week',
      [
        `- Runs: ${weekRuns.length} total, ${completed.length} completed, ${failed.length} failed.`,
        `- Commits: ${commits.length}.`,
        `- Patches: ${allPatches.length} total, ${openPatches.length} open.`,
      ],
      'No activity recorded.',
    ),
    '',
    section('Completed runs', completed.map(describeRun), 'No completed runs last week.'),
    '',
    section('Plan for next week', planLines, 'Nothing carried over — plan new work.'),
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
