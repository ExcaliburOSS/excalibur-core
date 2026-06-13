import { GitOperationError, PatchStore, applyPatch, getGitInfo } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { filesAffectedFromDiff } from '../lib/interactions';
import { appendPatchEvent, resolvePatch } from '../lib/patches';

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
      const repoRoot = deps.cwd();

      if (!getGitInfo(repoRoot).isRepo) {
        throw new CliUsageError(
          `Cannot apply patch ${patch.id}: ${repoRoot} is not a git repository. Run \`git init\` first.`,
        );
      }

      const store = new PatchStore(repoRoot);
      const diff = store.readArtifact(patch.id, 'diff.patch') ?? '';
      if (diff.trim().length === 0) {
        throw new CliUsageError(
          `Patch ${patch.id} has an empty diff — nothing to apply. Regenerate it with \`excalibur patch "<task>"\`.`,
        );
      }

      if (patch.metadata.diffApplies === false) {
        deps.ui.warn(
          `Patch ${patch.id} did not validate with \`git apply --check\` at proposal time; the apply below may fail.`,
        );
      }

      const confirmed =
        options.yes === true ||
        (await deps.ui.confirm(`Apply patch ${patch.id} to your working tree?`, {
          defaultYes: false,
        }));
      if (!confirmed) {
        deps.ui.info('Apply cancelled.');
        return;
      }

      try {
        applyPatch(repoRoot, diff);
      } catch (error) {
        if (error instanceof GitOperationError) {
          throw new CliUsageError(
            `Patch ${patch.id} did not apply: ${error.message}. ` +
              `Try \`excalibur branch ${patch.id}\` (applies onto a fresh branch) or regenerate the patch.`,
          );
        }
        throw error;
      }

      const filesAffected = filesAffectedFromDiff(diff);
      appendPatchEvent(patch, 'patch_applied', { patchId: patch.id, filesAffected });
      store.update(patch.id, {
        status: 'applied',
        completedAt: new Date().toISOString(),
      });
      deps.ui.success(
        `Applied patch ${patch.id} to your working tree (${
          filesAffected.length > 0 ? filesAffected.join(', ') : 'no files detected'
        }).`,
      );
    });
}
