import { applyPatch, getGitInfo, planAgentAllocation } from '@excalibur/core';
import {
  detectColorTier,
  detectThemeSync,
  parseDiffStat,
  renderLanes,
  type LaneModel,
} from '@excalibur/tui';
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
        throw new CliUsageError(deps.t('swarm.taskEmpty'));
      }
      const repoRoot = deps.cwd();
      if (!getGitInfo(repoRoot).isRepo) {
        throw new CliUsageError(deps.t('swarm.needsGitRepo'));
      }
      const maxAgents = parseMaxAgents(options.maxAgents);
      const gateway = loadGatewayContext(repoRoot);
      requireConfiguredModel(gateway); // a swarm of mock agents is pointless
      const { config } = loadConfigContext(repoRoot);

      deps.ui.info(deps.t('swarm.decomposing'));
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
      deps.ui.heading(deps.t('swarm.heading', { reason: allocation.reason }));
      lanes.forEach((subtask, index) => {
        deps.ui.write(`  ${index + 1}. ${subtask.title}`);
      });
      deps.ui.write();
      if (lanes.length === 1) {
        deps.ui.info(deps.t('swarm.singleUnit'));
      }

      const go =
        options.yes === true ||
        (await deps.ui.confirm(deps.t('swarm.confirmRun', { count: lanes.length }), { defaultYes: true }));
      if (!go) {
        deps.ui.info(deps.t('swarm.cancelled'));
        return;
      }

      deps.ui.info(deps.t('swarm.running'));
      const result = await executeSwarm(deps, repoRoot, lanes, {
        gateway: gateway.gateway,
        config,
        autonomyAutoApprove: true, // a parallel batch can't prompt per-lane
      });

      // The SWARM LANES panel: concurrent sub-rails branching off the swarm node
      // and converging on a fan-in merge node — the visual payoff of the
      // allocator (vs the one-at-a-time agent stacks of CC/OpenCode).
      const conflictIds = new Set(result.conflicts.map((c) => c.id));
      const laneModels: LaneModel[] = result.lanes.map((lane) => {
        const subtask = lanes.find((s) => s.id === lane.id);
        const hasChanges = lane.diff.trim().length > 0;
        const state: LaneModel['state'] = lane.failed
          ? 'failed'
          : conflictIds.has(lane.id)
            ? 'conflict'
            : hasChanges
              ? 'done'
              : 'empty';
        return {
          id: lane.id,
          title: subtask?.title ?? lane.id,
          state,
          ...(lane.result?.toolCalls !== undefined ? { toolCalls: lane.result.toolCalls } : {}),
          ...(hasChanges ? { diff: parseDiffStat(lane.diff) } : {}),
          ...(lane.result?.costCents != null ? { costCents: lane.result.costCents } : {}),
          ...(lane.failed
            ? { detail: lane.error ?? 'failed' }
            : conflictIds.has(lane.id)
              ? { detail: 'merge conflict' }
              : {}),
        };
      });
      const applied = laneModels.filter((l) => l.state === 'done').length;

      deps.ui.write();
      for (const line of renderLanes(
        { lanes: laneModels, applied, conflicts: result.conflicts.length },
        { tier: detectColorTier(), mode: detectThemeSync() ?? 'dark' },
      )) {
        deps.ui.write(line);
      }

      if (result.mergedDiff.trim().length === 0) {
        deps.ui.info(deps.t('swarm.noChanges'));
        return;
      }
      deps.ui.write();
      deps.ui.write(result.mergedDiff);

      const apply =
        options.apply === true ||
        (await deps.ui.confirm(deps.t('swarm.confirmApply'), {
          yes: options.yes,
          defaultYes: false,
        }));
      if (!apply) {
        deps.ui.info(deps.t('swarm.leftUnapplied'));
        return;
      }
      try {
        applyPatch(repoRoot, result.mergedDiff);
        deps.ui.success(deps.t('swarm.applied'));
      } catch (error) {
        deps.ui.error(deps.t('swarm.applyFailed', { error: error instanceof Error ? error.message : String(error) }));
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
