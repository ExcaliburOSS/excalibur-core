import { RunManager, generateWeeklyPlan, weeklyPlanFileName, writeReport } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';

/** `excalibur weekly-plan` — lightweight local weekly planning report (AA-8). */
export function registerWeeklyPlanCommand(program: Command, deps: CliDeps): void {
  program
    .command('weekly-plan')
    .description('summarize the week and draft a lightweight plan')
    .action(() => {
      const repoRoot = deps.cwd();
      const markdown = generateWeeklyPlan({
        repoRoot,
        runManager: new RunManager(repoRoot),
        locale: deps.locale,
      });
      deps.ui.write(markdown);
      const path = writeReport(repoRoot, weeklyPlanFileName(), markdown);
      deps.ui.info(deps.t('weekly-plan.saved', { path }));
    });
}
