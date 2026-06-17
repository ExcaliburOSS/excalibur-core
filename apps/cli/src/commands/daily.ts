import { RunManager, dailyReportFileName, generateDailyReport, writeReport } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';

/** `excalibur daily` — lightweight local daily summary (AA-8). */
export function registerDailyCommand(program: Command, deps: CliDeps): void {
  program
    .command('daily')
    .description('summarize local runs, patches and git activity for today')
    .action(() => {
      const repoRoot = deps.cwd();
      const markdown = generateDailyReport({ repoRoot, runManager: new RunManager(repoRoot), locale: deps.locale });
      deps.ui.write(markdown);
      const path = writeReport(repoRoot, dailyReportFileName(), markdown);
      deps.ui.info(`Saved to ${path}`);
    });
}
