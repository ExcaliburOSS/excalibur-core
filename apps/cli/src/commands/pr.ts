import { execFileSync } from 'node:child_process';
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
 * one from the run record when missing. `pr-create` opens a real pull request
 * from the current branch via the GitHub CLI (`gh`), using a run's summary as
 * the body.
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
    .description('open a pull request from the current branch via the GitHub CLI (gh)')
    .argument('[runId]', "run whose summary becomes the PR body (defaults to the latest run)")
    .option('--base <branch>', 'base branch for the PR (default: the repo default branch)')
    .option('--title <title>', 'PR title (default: the run title)')
    .option('--draft', 'open the PR as a draft')
    .option('--web', 'open the PR creation page in the browser instead of creating it headlessly')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(
      async (
        runId: string | undefined,
        options: { base?: string; title?: string; draft?: boolean; web?: boolean; yes?: boolean },
      ) => {
        const repoRoot = deps.cwd();
        // gh is the real dependency — refuse clearly when it's not installed/authed.
        if (!isCommandOnPath('gh', deps.env)) {
          throw new CliUsageError(deps.t('pr.ghRequired'));
        }
        const runManager = new RunManager(repoRoot);
        const run = runId !== undefined ? runManager.getRun(runId) : runManager.latestRun();
        const title = options.title ?? run?.record.title ?? 'Excalibur changes';
        // Body: prefer the run's generated PR summary, then its receipt, else a default.
        let bodyFile: string | undefined;
        if (run !== null) {
          const prSummary = join(run.dir, 'pr-summary.md');
          const summary = join(run.dir, 'summary.md');
          if (existsSync(prSummary)) bodyFile = prSummary;
          else if (existsSync(summary)) bodyFile = summary;
        }

        deps.ui.info(deps.t('pr.creating', { title }));
        // Opening a PR is outward-facing — confirm first unless --yes (or --web,
        // which is itself an interactive, abortable browser flow).
        const go =
          options.yes === true ||
          options.web === true ||
          (await deps.ui.confirm(deps.t('pr.confirmCreate'), { defaultYes: true }));
        if (!go) {
          deps.ui.info(deps.t('pr.cancelled'));
          return;
        }

        const args = ['pr', 'create', '--title', title];
        if (bodyFile !== undefined) args.push('--body-file', bodyFile);
        else args.push('--body', deps.t('pr.defaultBody'));
        if (options.base !== undefined) args.push('--base', options.base);
        if (options.draft === true) args.push('--draft');
        if (options.web === true) args.push('--web');

        try {
          const out = execFileSync('gh', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          // gh prints the PR URL on success (last non-empty stdout line).
          const url = out.trim().split('\n').filter((l) => l.trim().length > 0).pop() ?? '';
          deps.ui.success(deps.t('pr.created', { url }));
        } catch (error) {
          const stderr =
            typeof (error as { stderr?: unknown }).stderr === 'string'
              ? ((error as { stderr: string }).stderr).trim()
              : '';
          throw new CliUsageError(
            deps.t('pr.createFailed', { reason: stderr.length > 0 ? stderr : String(error) }),
          );
        }
      },
    );
}
