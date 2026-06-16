import { applyPatch, getGitInfo, planAgentAllocation } from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';
import { asAllocationSubtasks, decomposeTask, executeSwarm } from '../lib/swarm';

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
    .option('--apply', 'apply the merged changes to your working tree without prompting')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (taskWords: string[], options: { maxAgents?: string; apply?: boolean; yes?: boolean }) => {
      const task = taskWords.join(' ').trim();
      if (task.length === 0) {
        throw new CliUsageError('The task must not be empty.');
      }
      const repoRoot = deps.cwd();
      if (!getGitInfo(repoRoot).isRepo) {
        throw new CliUsageError('Swarm needs a git repository — each agent runs in an isolated worktree.');
      }
      const maxAgents = parseMaxAgents(options.maxAgents);
      const gateway = loadGatewayContext(repoRoot);
      requireConfiguredModel(gateway); // a swarm of mock agents is pointless
      const { config } = loadConfigContext(repoRoot);

      deps.ui.info('Decomposing the task into independent subtasks…');
      const subtasks = await decomposeTask(gateway.gateway, task, {
        provider: gateway.providerName,
        ...(maxAgents !== undefined ? { maxSubtasks: maxAgents } : {}),
      });

      const allocation = planAgentAllocation({
        taskType: 'feature',
        sensitive: false,
        subtasks: asAllocationSubtasks(subtasks),
        ...(maxAgents !== undefined ? { maxAgents } : {}),
      });
      const lanes = subtasks.slice(0, allocation.agentCount);

      deps.ui.write();
      deps.ui.heading(`Swarm: ${allocation.reason}`);
      lanes.forEach((subtask, index) => {
        deps.ui.write(`  ${index + 1}. ${subtask.title}`);
      });
      deps.ui.write();
      if (lanes.length === 1) {
        deps.ui.info('Only one independent unit — this runs as a single agent (no real fan-out).');
      }

      const go =
        options.yes === true ||
        (await deps.ui.confirm(`Run ${lanes.length} agent(s) in parallel?`, { defaultYes: true }));
      if (!go) {
        deps.ui.info('Swarm cancelled.');
        return;
      }

      deps.ui.info('Running… each agent works in its own isolated worktree.');
      const result = await executeSwarm(deps, repoRoot, lanes, {
        gateway: gateway.gateway,
        config,
        autonomyAutoApprove: true, // a parallel batch can't prompt per-lane
      });

      deps.ui.write();
      deps.ui.heading('Lanes:');
      for (const lane of result.lanes) {
        const subtask = lanes.find((s) => s.id === lane.id);
        const status = lane.failed ? '✗' : lane.diff.trim().length > 0 ? '±' : '·';
        const cost = lane.result?.costCents != null ? ` · $${(lane.result.costCents / 100).toFixed(2)}` : '';
        deps.ui.write(`  ${status} ${subtask?.title ?? lane.id}${cost}${lane.failed ? ` — ${lane.error ?? 'failed'}` : ''}`);
      }
      if (result.conflicts.length > 0) {
        deps.ui.warn(
          `${result.conflicts.length} lane(s) conflicted on merge and were left out: ${result.conflicts
            .map((c) => c.id)
            .join(', ')}.`,
        );
      }

      if (result.mergedDiff.trim().length === 0) {
        deps.ui.info('No changes were produced.');
        return;
      }
      deps.ui.write();
      deps.ui.write(result.mergedDiff);

      const apply =
        options.apply === true ||
        (await deps.ui.confirm('Apply the merged changes to your working tree?', {
          yes: options.yes,
          defaultYes: false,
        }));
      if (!apply) {
        deps.ui.info('Left unapplied. The merged diff is shown above.');
        return;
      }
      try {
        applyPatch(repoRoot, result.mergedDiff);
        deps.ui.success('Applied the merged swarm changes to your working tree.');
      } catch (error) {
        deps.ui.error(`Could not apply the merged diff: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function parseMaxAgents(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CliUsageError(`--max-agents must be a positive integer (got "${value}").`);
  }
  return parsed;
}
