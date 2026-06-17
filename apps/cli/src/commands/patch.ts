import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { generatePatch } from '../lib/interactions';
import { applyStoredPatch } from '../lib/patches';

/**
 * `excalibur patch "<task>"` — Level 2 patch proposal (COMMAND_DEFAULTS:
 * patch → propose-patch, L2). Writes the PatchStore artifact set and asks
 * `Apply patch? [y/N]` (safe default: no; `--yes` keeps the safe default).
 */
export function registerPatchCommand(program: Command, deps: CliDeps): void {
  program
    .command('patch')
    .description('generate a patch proposal without applying it (Level 2 — Propose Patch)')
    .argument('<task...>', 'what the patch should do')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (taskWords: string[], options: { yes?: boolean }) => {
      const task = taskWords.join(' ').trim();
      if (task.length === 0) {
        throw new CliUsageError(deps.t('patch.taskEmpty'));
      }

      const patch = await generatePatch(deps, task);

      const apply = await deps.ui.confirm(deps.t('patch.applyConfirm'), {
        yes: options.yes,
        defaultYes: false,
      });
      if (apply) {
        // Real `git apply` (M2) — the same path as `excalibur apply`.
        const { filesAffected } = applyStoredPatch(deps, patch);
        deps.ui.success(
          deps.t('patch.applied', {
            id: patch.id,
            files:
              filesAffected.length > 0
                ? filesAffected.join(', ')
                : deps.t('patch.noFilesDetected'),
          }),
        );
      } else {
        deps.ui.info(
          deps.t('patch.next', {
            id: patch.id,
          }),
        );
      }
    });
}
