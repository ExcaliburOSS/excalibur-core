import { PatchStore } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { appendPatchEvent, resolvePatch } from '../lib/patches';

/**
 * `excalibur apply [id]` — confirms and marks a patch as applied with a
 * `patch_applied { simulated: true }` event (M1 never modifies files).
 * `--yes` confirms because running `apply` already expresses intent.
 */
export function registerApplyCommand(program: Command, deps: CliDeps): void {
  program
    .command('apply')
    .description('apply a proposed patch (simulated in M1)')
    .argument('[id]', 'patch id (defaults to the latest patch)')
    .option('-y, --yes', 'apply without prompting')
    .action(async (id: string | undefined, options: { yes?: boolean }) => {
      const patch = resolvePatch(deps, id);
      const confirmed =
        options.yes === true ||
        (await deps.ui.confirm(`Apply patch ${patch.id} (simulated in M1)?`, {
          defaultYes: false,
        }));
      if (!confirmed) {
        deps.ui.info('Apply cancelled.');
        return;
      }
      appendPatchEvent(patch, 'patch_applied', { simulated: true, patchId: patch.id });
      new PatchStore(deps.cwd()).update(patch.id, {
        status: 'applied',
        completedAt: new Date().toISOString(),
      });
      deps.ui.success(
        `Patch ${patch.id} marked as applied (simulated — M1 never modifies your files).`,
      );
    });
}
