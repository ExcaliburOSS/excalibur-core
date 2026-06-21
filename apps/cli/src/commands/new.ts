import type { Command } from 'commander';
import { applyInitPlan, generateInitPlan } from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { createProjectDir, validateProjectName } from '../session/project-location';

/**
 * `excalibur new [name]` — explicit project creation (complements the
 * interactive shell's smart location detection). Creates `<cwd>/<name>` with
 * `git init` and a minimal `.excalibur/` scaffold, then points the user at it.
 * We can't change the parent shell's cwd, so we print `cd <name> && excalibur`
 * (running the shell there onboards the model on first launch).
 */
export function registerNewCommand(program: Command, deps: CliDeps): void {
  program
    .command('new [name]')
    .description('create a new project (git init + minimal .excalibur/) in a fresh subdirectory')
    .action(async (name?: string) => {
      let projectName = (name ?? '').trim();
      if (projectName.length === 0) {
        if (!deps.ui.isInteractive()) {
          throw new CliUsageError(deps.t('new.name-required'));
        }
        projectName = (
          await deps.ui.ask(deps.t('project-location.ask-name'), { defaultAnswer: 'my-project' })
        ).trim();
      }
      const error = validateProjectName(projectName);
      if (error !== null) {
        throw new CliUsageError(deps.t(`project-location.name-${error}`));
      }

      let root: string;
      try {
        root = createProjectDir(deps.cwd(), projectName, deps.env);
      } catch {
        throw new CliUsageError(deps.t('project-location.name-exists', { name: projectName }));
      }

      const analysis = await analyzeRepository(root, {
        homeDir: deps.homeDir(),
        includeUserGlobal: deps.includeUserGlobal,
      });
      const plan = generateInitPlan(analysis, { mode: 'minimal', locale: deps.locale });
      const result = applyInitPlan(root, plan, { overwrite: false });

      deps.ui.success(deps.t('project-location.created', { name: projectName, path: root }));
      if (result.written.length > 0) {
        deps.ui.heading(deps.t('onboarding.created'));
        for (const relPath of result.written) {
          deps.ui.write(`  + ${relPath}`);
        }
      }
      deps.ui.info(deps.t('new.next-steps', { name: projectName }));
    });
}
