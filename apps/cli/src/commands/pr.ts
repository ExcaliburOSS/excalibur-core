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
        throw new CliUsageError('No local runs yet. Start one with: excalibur run "<task>"');
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
      deps.ui.info(`Saved to ${existing}`);
    });

  program
    .command('pr-create')
    .description('open a pull request via the GitHub CLI (arrives in OSS-9 / M2)')
    .action(() => {
      const ghAvailable = isCommandOnPath('gh', deps.env);
      deps.ui.warn(
        'Honest stub: `pr-create` activates in milestone OSS-9 (M2), opening pull requests through the GitHub CLI.',
      );
      if (ghAvailable) {
        deps.ui.success('GitHub CLI (gh) detected — you are ready for M2.');
      } else {
        deps.ui.info('GitHub CLI (gh) not found on PATH. Install it from https://cli.github.com to be ready.');
      }
      deps.ui.info('Until then: excalibur pr-summary prints a summary you can paste into a PR.');
    });
}
