import { getGitInfo } from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';
import { runSwarmFlow } from '../lib/swarm';

/**
 * `excalibur swarm "<task>"` (M3) — real parallel agents. A model decomposes the
 * task into INDEPENDENT subtasks, the allocator sizes the swarm, and one real
 * native-agent loop runs per subtask in an isolated git worktree; their work is
 * fanned in (conflicts reported) and the merged diff is offered for apply. Needs
 * a real model (a swarm of mock agents is pointless) and a git repository.
 */
export function registerSwarmCommand(program: Command, deps: CliDeps): void {
  program
    .command('swarm')
    .description('run independent subtasks of a task as parallel agents (M3, isolated worktrees)')
    .argument('<task...>', 'the task to fan out')
    .option('--max-agents <n>', 'hard ceiling on the number of parallel agents')
    .option('--retries <n>', 're-dispatch a failed lane up to N times (grader/rubric retry)')
    .option(
      '--grade',
      'grade each lane against its subtask and revise failing lanes with feedback until they pass (drops below-bar lanes from the merge)',
    )
    .option('--apply', 'apply the merged changes to your working tree without prompting')
    .option('-y, --yes', 'skip prompts and apply the merged changes (same as --apply)')
    .option('--work-item <key>', 'link every lane to an existing work item (e.g. WI-12)')
    .action(
      async (
        taskWords: string[],
        options: {
          maxAgents?: string;
          retries?: string;
          grade?: boolean;
          apply?: boolean;
          yes?: boolean;
          workItem?: string;
        },
      ) => {
        const task = taskWords.join(' ').trim();
        if (task.length === 0) {
          throw new CliUsageError(deps.t('swarm.taskEmpty'));
        }
        const repoRoot = deps.cwd();
        if (!getGitInfo(repoRoot).isRepo) {
          throw new CliUsageError(deps.t('swarm.needsGitRepo'));
        }
        const maxAgents = parseMaxAgents(options.maxAgents);
        const retries = parseRetries(options.retries);
        const gateway = loadGatewayContext(repoRoot);
        requireConfiguredModel(gateway, deps.t); // a swarm of mock agents is pointless
        const { config } = loadConfigContext(repoRoot);

        await runSwarmFlow(
          deps,
          repoRoot,
          task,
          {
            gateway: gateway.gateway,
            providerName: gateway.providerName,
            config,
            ...(options.workItem !== undefined ? { workItemId: options.workItem } : {}),
          },
          {
            ...(maxAgents !== undefined ? { maxAgents } : {}),
            ...(retries !== undefined ? { retries } : {}),
            ...(options.grade === true ? { grade: true } : {}),
            ...(options.apply === true ? { apply: true } : {}),
            ...(options.yes === true ? { yes: true } : {}),
          },
        );
      },
    );
}

function parseMaxAgents(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`--max-agents must be a positive integer (got "${value}").`);
  }
  return parsed;
}

function parseRetries(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CliUsageError(`--retries must be a non-negative integer (got "${value}").`);
  }
  return parsed;
}
