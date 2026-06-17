import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { applyStoredPatch, resolvePatch } from '../lib/patches';

/**
 * `excalibur apply [id]` — applies a proposed patch's `diff.patch` to the
 * working tree with real `git apply`, then records a `patch_applied` event and
 * marks the patch `applied`. Running `apply` already expresses intent, so
 * `--yes` confirms; otherwise the user is prompted.
 */
export function registerApplyCommand(program: Command, deps: CliDeps): void {
  program
    .command('apply')
    .description('apply a proposed patch to the working tree (git apply)')
    .argument('[id]', 'patch id (defaults to the latest patch)')
    .option('-y, --yes', 'apply without prompting')
    .action(async (id: string | undefined, options: { yes?: boolean }) => {
      const patch = resolvePatch(deps, id);

      const confirmed =
        options.yes === true ||
        (await deps.ui.confirm(deps.t('apply.confirm', { id: patch.id }), {
          defaultYes: false,
        }));
      if (!confirmed) {
        deps.ui.info(deps.t('apply.cancelled'));
        return;
      }

      const { filesAffected } = applyStoredPatch(deps, patch);
      deps.ui.success(
        deps.t('apply.applied', {
          id: patch.id,
          files:
            filesAffected.length > 0
              ? filesAffected.join(', ')
              : deps.t('apply.no-files'),
        }),
      );
    });
}
