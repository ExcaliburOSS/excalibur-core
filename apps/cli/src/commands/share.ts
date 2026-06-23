import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunManager } from '@excalibur/core';
import { reduceRail } from '@excalibur/tui';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { buildRunShareHtml } from '../lib/share-export';

const RUN_ID = /^run_\d{8}_\d{6}(?:_[a-z0-9]+)?$/;

/**
 * `excalibur share <runId> [--out <path>]` — export a run as a STATIC,
 * self-contained read-only HTML snapshot (P2.19). No server, no hosting: the
 * run's record + reduced rail are embedded into one file you can open offline or
 * drop on any static host. (For a LIVE shared view of running runs, use
 * `excalibur serve --share`, which mints a read-only token.)
 */
export function registerShareCommand(program: Command, deps: CliDeps): void {
  program
    .command('share')
    .description('export a run as a static, self-contained read-only HTML snapshot')
    .argument('<runId>', 'the run id to export (e.g. run_20260623_101500)')
    .option('--out <path>', 'output file path (default: .excalibur/shares/<runId>.html)')
    .action((runId: string, options: { out?: string }) => {
      if (!RUN_ID.test(runId)) {
        throw new CliUsageError(`invalid run id "${runId}".`);
      }
      const repoRoot = deps.cwd();
      const manager = new RunManager(repoRoot);
      let record;
      try {
        record = manager.getRun(runId).record;
      } catch {
        throw new CliUsageError(`run "${runId}" not found in .excalibur/runs/.`);
      }
      const rail = reduceRail(manager.readEvents(runId));
      const html = buildRunShareHtml(record, rail);

      const outPath =
        options.out !== undefined
          ? join(repoRoot, options.out)
          : join(repoRoot, '.excalibur', 'shares', `${runId}.html`);
      mkdirSync(join(outPath, '..'), { recursive: true });
      writeFileSync(outPath, html, 'utf8');
      deps.ui.success(`Wrote a self-contained, read-only share to ${outPath}`);
      deps.ui.write('Open it in a browser or host it anywhere static — it needs no server.');
    });
}
