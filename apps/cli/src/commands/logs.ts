import { RunManager } from '@excalibur/core';
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

/** `excalibur logs [runId] [--json]` — prettified events.jsonl of a run. */
export function registerLogsCommand(program: Command, deps: CliDeps): void {
  program
    .command('logs')
    .description('show the event log of a run (defaults to the latest run)')
    .argument('[runId]', 'run id')
    .option('--json', 'machine-readable JSON output')
    .action((runId: string | undefined, options: { json?: boolean }) => {
      const runManager = new RunManager(deps.cwd());
      const run = runId !== undefined ? runManager.getRun(runId) : runManager.latestRun();
      if (run === null) {
        throw new CliUsageError('No local runs yet. Start one with: excalibur run "<task>"');
      }
      const events = runManager.readEvents(run.id);
      if (options.json === true) {
        deps.ui.json(events);
        return;
      }
      deps.ui.heading(`${run.id} — ${run.record.title} (${run.record.status})`);
      if (events.length === 0) {
        deps.ui.info('No events recorded.');
        return;
      }
      for (const event of events) {
        const time = event.timestamp.slice(11, 19);
        deps.ui.write(
          `${pc.dim(time)} ${pc.bold(event.type.padEnd(20))} ${pc.dim(compactPayload(event.payload))}`,
        );
      }
    });
}
