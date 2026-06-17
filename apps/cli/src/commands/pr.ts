import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCommandOnPath } from '@excalibur/agent-runtime';
import { RunManager } from '@excalibur/core';
import type { ChatMessage } from '@excalibur/model-gateway';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { chatWithGuidance, loadGatewayContext } from '../lib/context';

/**
 * `excalibur pr-summary` — prints the latest run's pr-summary.md, generating
 * one from the run record when missing. `pr-create` is an honest OSS-9 stub
 * that checks for the `gh` CLI.
 */
export function registerPrCommands(program: Command, deps: CliDeps): void {
  program
    .command('pr-summary')
    .description("print (or generate) the latest run's pull-request summary")
    .argument('[runId]', 'run id (defaults to the latest run)')
    .action(async (runId: string | undefined) => {
      const repoRoot = deps.cwd();
      const runManager = new RunManager(repoRoot);
      const run = runId !== undefined ? runManager.getRun(runId) : runManager.latestRun();
      if (run === null) {
        throw new CliUsageError(deps.t('pr.noRuns'));
      }

      const existing = join(run.dir, 'pr-summary.md');
      if (existsSync(existing)) {
        deps.ui.write(readFileSync(existing, 'utf8'));
        return;
      }

      const summaryFile = join(run.dir, 'summary.md');
      const summary = existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '';
      const gatewayContext = loadGatewayContext(repoRoot);
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are the Excalibur release assistant. Write a PR summary.' },
        {
          role: 'user',
          content: `Write a pull-request summary for the run "${run.record.title}" (workflow ${run.record.workflow}, status ${run.record.status}).\n\n${summary}`,
        },
      ];
      const { output } = await chatWithGuidance(deps, gatewayContext, {
        messages,
        metadata: { kind: 'summary' },
      });
      runManager.writeArtifact(run.id, 'pr-summary.md', `${output.content}\n`);
      deps.ui.write(output.content);
      deps.ui.info(deps.t('pr.saved', { path: existing }));
    });

  program
    .command('pr-create')
    .description('open a pull request via the GitHub CLI (arrives in OSS-9 / M2)')
    .action(() => {
      const ghAvailable = isCommandOnPath('gh', deps.env);
      deps.ui.warn(deps.t('pr.stub'));
      if (ghAvailable) {
        deps.ui.success(deps.t('pr.ghDetected'));
      } else {
        deps.ui.info(deps.t('pr.ghMissing'));
      }
      deps.ui.info(deps.t('pr.untilThen'));
    });
}
