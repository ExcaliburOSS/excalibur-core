import { RunManager } from '@excalibur/core';
import { AUTONOMY_LEVEL_LABELS, type AutonomyLevel } from '@excalibur/shared';
import { detectColorTier, detectThemeSync, reduceRail, renderRail } from '@excalibur/tui';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';

function compactPayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.join(' ');
}

/**
 * `excalibur logs [runId] [--events] [--json]` — inspect a past run.
 *
 * By default this folds the run's `events.jsonl` through the SAME `reduceRail`
 * the live view uses and renders the LIVING RAIL with every phase expanded — a
 * structured, glyphed replay (the time-machine surface). `--events` prints the
 * raw event list; `--json` the raw events as JSON.
 */
export function registerLogsCommand(program: Command, deps: CliDeps): void {
  program
    .command('logs')
    .description('inspect a run as the LIVING RAIL (defaults to the latest run)')
    .argument('[runId]', 'run id')
    .option('--events', 'show the raw event list instead of the rail')
    .option('--json', 'machine-readable JSON output')
    .action((runId: string | undefined, options: { events?: boolean; json?: boolean }) => {
      const runManager = new RunManager(deps.cwd());
      const run = runId !== undefined ? runManager.getRun(runId) : runManager.latestRun();
      if (run === null) {
        throw new CliUsageError(deps.t('logs.noRuns'));
      }
      const events = runManager.readEvents(run.id);
      if (options.json === true) {
        deps.ui.json(events);
        return;
      }

      deps.ui.heading(
        deps.t('logs.heading', {
          id: run.id,
          title: run.record.title,
          status: run.record.status,
        }),
      );
      if (events.length === 0) {
        deps.ui.info(deps.t('logs.noEvents'));
        return;
      }

      if (options.events === true) {
        for (const event of events) {
          const time = event.timestamp.slice(11, 19);
          deps.ui.write(
            `${pc.dim(time)} ${pc.bold(event.type.padEnd(20))} ${pc.dim(compactPayload(event.payload))}`,
          );
        }
        return;
      }

      // The rail replay: reduce the stored stream and render it fully expanded.
      const level = run.record.autonomyLevel as AutonomyLevel;
      const rail = reduceRail(events, {
        autonomyLabel: AUTONOMY_LEVEL_LABELS[level] ?? '',
        model: run.record.model ?? 'mock',
      });
      for (const line of renderRail(rail, {
        tier: detectColorTier(),
        mode: detectThemeSync() ?? 'dark',
        expandAll: true,
      })) {
        deps.ui.write(line);
      }
    });
}
