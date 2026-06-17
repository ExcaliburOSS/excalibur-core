import { buildTurnSummary, changeGlyph, loadReplay, reconstructStateAt } from '@excalibur/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { resolveRun } from '../lib/replay-scrubber';

interface ChangesOptions {
  diff?: boolean;
}

/**
 * `excalibur changes [id]` — the progressive-disclosure target of the post-turn
 * receipt. The receipt shows a capped file list inline; `changes` prints the
 * FULL changed-file list with diffstat, and (with `--diff`) the accumulated
 * unified diff. Defaults to the latest run. Read-only and scriptable.
 */
export function registerChangesCommand(program: Command, deps: CliDeps): void {
  program
    .command('changes')
    .description('show the full changed-file list (and `--diff`) for a run')
    .argument('[id]', 'run id (defaults to the latest run)')
    .option('--diff', 'also print the accumulated unified diff')
    .action((id: string | undefined, options: ChangesOptions) => {
      const { id: runId } = resolveRun(deps, id);
      const repoRoot = deps.cwd();
      const model = loadReplay(repoRoot, runId);
      const summary = buildTurnSummary(model);

      deps.ui.heading(deps.t('changes.heading', { runId }));
      if (summary.changedFiles.length === 0) {
        deps.ui.write(pc.dim(deps.t('changes.noFileChanges')));
      } else {
        const { metrics } = summary;
        deps.ui.write(
          pc.dim(
            deps.t('changes.diffstat', {
              files: metrics.files,
              plural: metrics.files === 1 ? '' : 's',
              insertions: metrics.insertions,
              deletions: metrics.deletions,
            }),
          ),
        );
        deps.ui.write();
        for (const file of summary.changedFiles) {
          const stat =
            file.insertions === 0 && file.deletions === 0
              ? ''
              : `  +${file.insertions} −${file.deletions}`;
          deps.ui.write(`  ${changeGlyph(file.status)}  ${file.path}${pc.dim(stat)}`);
        }
      }

      if (options.diff === true) {
        const last = model.steps.length - 1;
        const diff = last >= 0 ? reconstructStateAt(model, last).accumulatedDiff : '';
        deps.ui.write();
        if (diff.trim().length === 0) {
          deps.ui.write(pc.dim(deps.t('changes.noUnifiedDiff')));
        } else {
          deps.ui.write(diff);
        }
      }
    });
}
