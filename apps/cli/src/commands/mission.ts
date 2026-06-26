import type { AutonomyLevel } from '@excalibur/shared';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { loadConfigContext } from '../lib/context';
import { runMissionTurn } from '../session/mission-run';

/**
 * `excalibur mission <goal...>` — the meta-orchestrator as a direct command. Give
 * a big, multi-faceted goal and Excalibur INTERPRETS it, auto-authors a capability
 * plan (understand → … → verify → ship), and DRIVES it autonomously, adapting as it
 * learns. The non-interactive twin of the proactive in-shell `mission` route; runs
 * auto-approved (a direct command opts in), checkpointed (resume a long job).
 */
export function registerMissionCommand(program: Command, deps: CliDeps): void {
  program
    .command('mission <goal...>')
    .description(
      'run a big goal end to end — the meta-orchestrator plans and drives it autonomously',
    )
    .option(
      '--budget <usd>',
      'hard budget ceiling in USD; the mission pauses (resumable) when reached',
    )
    .option(
      '--pr',
      'open a real pull request at the ship step (branch, push, gh pr create) instead of committing locally',
    )
    .action(async (goal: string[], options: { budget?: string; pr?: boolean }) => {
      const repoRoot = deps.cwd();
      const { config } = loadConfigContext(repoRoot);
      const ctrl = new AbortController();
      const onSigint = (): void => ctrl.abort();
      process.once('SIGINT', onSigint);
      const budgetUsd =
        options.budget !== undefined ? Number.parseFloat(options.budget) : undefined;
      try {
        await runMissionTurn(goal.join(' '), {
          deps,
          repoRoot,
          config,
          autonomyLevel: (config.autonomy?.default ?? 4) as AutonomyLevel,
          approvals: { auto: true }, // a direct command runs unattended (like run --yes)
          signal: ctrl.signal,
          ...(options.pr === true ? { openPr: true } : {}),
          ...(budgetUsd !== undefined && Number.isFinite(budgetUsd)
            ? { budgetCents: Math.round(budgetUsd * 100) }
            : {}),
        });
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
    });
}
