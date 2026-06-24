import { getGitInfo } from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';
import { runExploreFlow } from '../lib/explore';

/**
 * `excalibur explore "<task>"` (AO5) — best-of-N. Fans the SAME task to N
 * candidate agents in isolated git worktrees (diversified by approach, not by
 * sampling), a model judge picks the winner, and ONLY the winner is applied
 * (ground-truth gated when a test command is configured). The parallel
 * counterpart to the single-agent `run --explore` workflow.
 */
export function registerExploreCommand(program: Command, deps: CliDeps): void {
  program
    .command('explore')
    .description('best-of-N: run N candidate approaches in parallel and apply the best')
    .argument('<task...>', 'the task to explore')
    .option('--candidates <n>', 'how many candidate approaches to run (default 3)')
    .option('-y, --yes', 'skip prompts and apply the winning candidate')
    .action(async (taskWords: string[], options: { candidates?: string; yes?: boolean }) => {
      const task = taskWords.join(' ').trim();
      if (task.length === 0) {
        throw new CliUsageError(deps.t('swarm.taskEmpty'));
      }
      const repoRoot = deps.cwd();
      if (!getGitInfo(repoRoot).isRepo) {
        throw new CliUsageError(deps.t('swarm.needsGitRepo'));
      }
      const candidates = parseCandidates(options.candidates);
      const gateway = loadGatewayContext(repoRoot);
      requireConfiguredModel(gateway, deps.t); // best-of-N over the mock is pointless
      const { config } = loadConfigContext(repoRoot);

      await runExploreFlow(
        deps,
        repoRoot,
        task,
        { gateway: gateway.gateway, providerName: gateway.providerName, config },
        {
          ...(candidates !== undefined ? { candidates } : {}),
          ...(options.yes === true ? { yes: true } : {}),
        },
      );
    });
}

function parseCandidates(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 2) {
    throw new CliUsageError(`--candidates must be an integer ≥ 2 (got "${value}").`);
  }
  return parsed;
}
