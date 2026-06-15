import { applyPatch, checkPatchApplies, loadReplay, planUndo } from '@excalibur/core';
import type { AutonomyLevel } from '@excalibur/shared';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { loadConfigContext, loadGatewayContext } from '../lib/context';
import { resolveRun } from '../lib/replay-scrubber';
import { runForkTurn, type AgentTurnDeps } from '../session/agent-turn';

interface ForkOptions {
  at?: string;
  level?: string;
}

interface UndoOptions {
  at?: string;
  yes?: boolean;
}

/** Parses a 1-based `--at <n>` into a 0-based step index against the run length. */
function resolveStep(deps: CliDeps, runId: string, at: string | undefined): number {
  const model = loadReplay(deps.cwd(), runId);
  const total = model.steps.length;
  if (total === 0) {
    throw new CliUsageError(`Run "${runId}" has no recorded steps.`);
  }
  if (at === undefined) {
    return total - 1; // default to the last step
  }
  if (!/^\d+$/.test(at.trim())) {
    throw new CliUsageError(`--at must be a whole step number between 1 and ${total} (got "${at}").`);
  }
  const n = Number.parseInt(at.trim(), 10);
  if (n < 1 || n > total) {
    throw new CliUsageError(`--at must be a step between 1 and ${total} (got "${at}").`);
  }
  return n - 1;
}

/**
 * `excalibur fork <id> "<instruction>"` — the time-machine's killer move.
 * Branches a NEW run from step N of a source run (`--at`, default the last
 * step), replaying the prefix FROM CACHE — zero tokens re-spent, the worktree
 * reconstructed to the state at N in an isolated git worktree — and running only
 * the new instruction live. "Start from scratch" disappears.
 */
export function registerForkCommand(program: Command, deps: CliDeps): void {
  program
    .command('fork')
    .description('fork a run from a step, reusing the cached prefix — run a new instruction from there')
    .argument('[id]', 'source run id (defaults to the latest run)')
    .argument('<instruction>', 'what to do from the fork point')
    .option('--at <n>', 'fork at step n (1-based; defaults to the last step)')
    .option('--level <0-4>', 'autonomy level for the forked run (default 3)')
    .action(async (id: string | undefined, instruction: string, options: ForkOptions) => {
      const { id: runId } = resolveRun(deps, id);
      const atStep = resolveStep(deps, runId, options.at);
      const level = parseLevel(options.level);

      const { config } = loadConfigContext(deps.cwd());
      const gateway = loadGatewayContext(deps.cwd());
      const turn: AgentTurnDeps = {
        deps,
        repoRoot: deps.cwd(),
        config,
        gateway: gateway.gateway,
        providerName: gateway.providerName,
        autonomyLevel: level,
      };

      const result = await runForkTurn(turn, { sourceRunId: runId, atStep, instruction });
      deps.ui.write();
      deps.ui.info(`Fork ${result.forkRunId} created. Inspect it in its worktree, or replay it: excalibur replay ${result.forkRunId}`);
    });
}

/**
 * `excalibur undo <id> --at <n>` — revert the WORKING TREE to a run's state at
 * step N. Conservative + gated: it reverse-applies the run's changes (pre-flight
 * with `git apply --check`, so a diverged tree aborts BEFORE any mutation), then
 * re-applies up to step N. Worst case leaves the tree at the run's base (the
 * changes cleanly undone), never a corrupted half-state.
 */
export function registerUndoCommand(program: Command, deps: CliDeps): void {
  program
    .command('undo')
    .description("revert the working tree to a run's state at a step (gated, pre-flight-checked)")
    .argument('[id]', 'run id (defaults to the latest run)')
    .option('--at <n>', 'revert to the state at step n (1-based; defaults to before the run)')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (id: string | undefined, options: UndoOptions) => {
      const { id: runId } = resolveRun(deps, id);
      const repoRoot = deps.cwd();
      // Default target: step 0 (before the run did anything) → fully undo.
      const atStep = options.at === undefined ? 0 : resolveStep(deps, runId, options.at);
      const plan = planUndo(repoRoot, runId, atStep);

      if (plan.fullDiff.trim().length === 0) {
        deps.ui.info(`Run ${runId} recorded no file changes — nothing to undo.`);
        return;
      }

      // Pre-flight: can we cleanly unwind the run's changes from the tree?
      const canReverse = checkPatchApplies(repoRoot, plan.fullDiff, { reverse: true });
      if (!canReverse.applies) {
        throw new CliUsageError(
          `Cannot undo: the run's changes do not reverse-apply cleanly to your working tree ` +
            `(${canReverse.reason ?? 'diverged'}). The tree has changed since the run; resolve it first.`,
        );
      }

      deps.ui.warn(
        `This reverts your working tree to run ${runId}'s state at step ${plan.atStep + 1}/${plan.totalSteps}.`,
      );
      if (options.yes !== true && deps.ui.isInteractive()) {
        const ok = await deps.ui.confirm('Proceed?', { defaultYes: false });
        if (!ok) {
          deps.ui.info('Undo cancelled. Nothing was changed.');
          return;
        }
      }

      // Unwind the run's changes (pre-flighted above), bringing the tree to the
      // run's base.
      applyPatch(repoRoot, plan.fullDiff, { reverse: true });

      if (plan.targetDiff.trim().length === 0) {
        // Target IS the base — nothing to re-apply.
        deps.ui.info(pc.green(`✓ Working tree reverted — the run's changes were undone.`));
        return;
      }

      // Re-apply up to the checkpoint. If it will not apply, RESTORE the original
      // tree (forward-apply the run's changes again) and abort — never silently
      // leave the user at a different step than they asked for.
      const canReapply = checkPatchApplies(repoRoot, plan.targetDiff);
      if (!canReapply.applies) {
        applyPatch(repoRoot, plan.fullDiff); // forward — restores the pre-undo state
        throw new CliUsageError(
          `Could not reconstruct step ${plan.atStep + 1} (${canReapply.reason ?? 'no clean apply'}). ` +
            `Your working tree was left UNCHANGED.`,
        );
      }
      applyPatch(repoRoot, plan.targetDiff);
      deps.ui.info(pc.green(`✓ Working tree reverted to step ${plan.atStep + 1}.`));
    });
}

function parseLevel(value: string | undefined): AutonomyLevel {
  if (value === undefined) {
    return 3;
  }
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0 || n > 4) {
    throw new CliUsageError(`--level must be between 0 and 4 (got "${value}").`);
  }
  return n as AutonomyLevel;
}
