import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunManager } from '../runs/run-manager';
import { PatchStore } from '../stores/artifact-stores';
import { initGitRepo, makeTempDir, removeDir } from '../test-utils';
import {
  dailyReportFileName,
  generateDailyReport,
  generateWeeklyPlan,
  isoWeek,
  weeklyPlanFileName,
  writeReport,
} from './reports';

describe('reports', () => {
  let repoRoot: string;
  let runManager: RunManager;

  beforeEach(() => {
    repoRoot = makeTempDir();
    initGitRepo(repoRoot);
    runManager = new RunManager(repoRoot);
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  function seedActivity(): void {
    const completed = runManager.createRun({
      title: 'Fix duplicated escrow release',
      autonomyLevel: 3,
      workflow: 'fast-fix',
    });
    runManager.updateRecord(completed.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });

    const failed = runManager.createRun({
      title: 'Broken migration attempt',
      autonomyLevel: 4,
      workflow: 'migration',
    });
    runManager.updateRecord(failed.id, { status: 'failed' });

    runManager.createRun({
      title: 'Waiting for approval',
      autonomyLevel: 4,
      workflow: 'human-gated',
    });

    new PatchStore(repoRoot).create({
      input: 'Fix webhook',
      effectiveInstructions: '',
      diff: '--- a/x.ts\n+++ b/x.ts\n',
      summary: 'A patch',
    });
  }

  it('generates a daily report covering runs, patches, commits and pending items', () => {
    seedActivity();
    const markdown = generateDailyReport({ repoRoot, runManager });

    expect(markdown).toContain('# Daily Report —');
    expect(markdown).toContain('## Completed runs');
    expect(markdown).toContain('Fix duplicated escrow release');
    expect(markdown).toContain('(fast-fix, L3) — completed');
    expect(markdown).toContain('## Failed runs');
    expect(markdown).toContain('Broken migration attempt');
    expect(markdown).toContain('## Patches');
    expect(markdown).toMatch(/patch_\d{8}_\d{6}/);
    expect(markdown).toContain('## Commits');
    expect(markdown).toContain('initial commit');
    expect(markdown).toContain('## Pending');
    expect(markdown).toContain('Waiting for approval');
  });

  it('reports empty sections honestly when there is no activity', () => {
    const markdown = generateDailyReport({
      repoRoot: makeTempDir(),
      runManager: new RunManager(makeTempDir()),
    });
    expect(markdown).toContain('_No completed runs today._');
    expect(markdown).toContain('_No commits today._');
    expect(markdown).toContain('_Nothing pending._');
  });

  it('generates a weekly plan with carried-over work', () => {
    seedActivity();
    const markdown = generateWeeklyPlan({ repoRoot, runManager });

    expect(markdown).toContain('# Weekly Plan —');
    expect(markdown).toContain('## Last week');
    expect(markdown).toContain('## Plan for next week');
    expect(markdown).toContain('Revisit failed run');
    expect(markdown).toContain('Waiting for approval');
    expect(markdown).toContain('Review and apply (or reject) patch');
  });

  it('writes reports into .excalibur/reports/ with the pinned file names', () => {
    const now = new Date(2026, 5, 12); // 2026-06-12, ISO week 24
    expect(dailyReportFileName(now)).toBe('daily-2026-06-12.md');
    expect(weeklyPlanFileName(now)).toBe('weekly-plan-2026-W24.md');
    expect(isoWeek(new Date(2026, 0, 1))).toEqual({ year: 2026, week: 1 });

    const markdown = generateDailyReport({ repoRoot, runManager, now });
    const reportPath = writeReport(repoRoot, dailyReportFileName(now), markdown);
    expect(reportPath).toBe(join(repoRoot, '.excalibur', 'reports', 'daily-2026-06-12.md'));
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, 'utf8')).toContain('# Daily Report — 2026-06-12');
  });
});
