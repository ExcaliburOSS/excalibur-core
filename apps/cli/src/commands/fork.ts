import { loadReplay } from '@excalibur/core';
import type { AutonomyLevel } from '@excalibur/shared';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';
import { resolveRun } from '../lib/replay-scrubber';
import { runForkTurn, runUndo, type AgentTurnDeps } from '../session/agent-turn';

interface ForkOptions {
  at?: string;
  level?: string;
  yes?: boolean;
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
    throw new CliUsageError(deps.t('fork.noSteps', { runId }));
  }
  if (at === undefined) {
    return total - 1; // default to the last step
  }
  if (!/^\d+$/.test(at.trim())) {
    throw new CliUsageError(deps.t('fork.atNotWhole', { total, at }));
  }
  const n = Number.parseInt(at.trim(), 10);
  if (n < 1 || n > total) {
    throw new CliUsageError(deps.t('fork.atOutOfRange', { total, at }));
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
    .option('-y, --yes', 'auto-approve the forked run’s edits/commands (non-interactive)')
    .action(async (id: string | undefined, instruction: string, options: ForkOptions) => {
      const { id: runId } = resolveRun(deps, id);
      const atStep = resolveStep(deps, runId, options.at);
      const level = parseLevel(options.level);

      const { config } = loadConfigContext(deps.cwd());
      const gateway = loadGatewayContext(deps.cwd());
      requireConfiguredModel(gateway, deps.t); // no mock fallback: a real LLM is required
      const turn: AgentTurnDeps = {
        deps,
        repoRoot: deps.cwd(),
        config,
        gateway: gateway.gateway,
        providerName: gateway.providerName,
        autonomyLevel: level,
        // --yes (or a non-interactive shell) auto-approves the fork's mutations;
        // otherwise the agent prompts per edit. Blocked paths stay hard-denied.
        approvals: {
          auto: options.yes === true || !deps.ui.isInteractive(),
          always: new Set<string>(),
        },
      };

      const result = await runForkTurn(turn, { sourceRunId: runId, atStep, instruction });
      deps.ui.write();
      deps.ui.info(deps.t('fork.created', { forkRunId: result.forkRunId }));
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
      // Default target: step 0 (before the run did anything) → fully undo.
      const atStep = options.at === undefined ? 0 : resolveStep(deps, runId, options.at);
      await runUndo(deps, runId, atStep, { yes: options.yes });
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
