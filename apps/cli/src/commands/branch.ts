import { GitOperationError, PatchStore, applyPatch, createBranch, getGitInfo } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { filesAffectedFromDiff } from '../lib/interactions';
import { appendPatchEvent, resolvePatch } from '../lib/patches';

/**
 * `excalibur branch [id]` — creates a REAL local git branch named
 * `excalibur/<id>` for a patch and applies the patch's `diff.patch` onto it
 * with real `git apply`, so the change lands isolated from the current branch.
 */
export function registerBranchCommand(program: Command, deps: CliDeps): void {
  program
    .command('branch')
    .description('create branch excalibur/<id> and apply the patch onto it')
    .argument('[id]', 'patch id (defaults to the latest patch)')
    .option('-y, --yes', 'create the branch without prompting')
    .action(async (id: string | undefined, options: { yes?: boolean }) => {
      const patch = resolvePatch(deps, id);
      const repoRoot = deps.cwd();
      const branchName = `excalibur/${patch.id}`;

      if (!getGitInfo(repoRoot).isRepo) {
        throw new CliUsageError(
          deps.t('branch.not-a-repo', { branchName, repoRoot }),
        );
      }

      const store = new PatchStore(repoRoot);
      const diff = store.readArtifact(patch.id, 'diff.patch') ?? '';
      if (diff.trim().length === 0) {
        throw new CliUsageError(
          deps.t('branch.empty-diff', { patchId: patch.id }),
        );
      }

      const confirmed =
        options.yes === true ||
        (await deps.ui.confirm(deps.t('branch.confirm', { branchName }), {
          defaultYes: false,
        }));
      if (!confirmed) {
        deps.ui.info(deps.t('branch.cancelled'));
        return;
      }

      createBranch(repoRoot, branchName);

      // The branch now exists and is checked out. Try to apply the diff onto
      // it; if git refuses, report honestly and leave the user on the branch
      // for a manual fix rather than crashing or rolling the branch back.
      const filesAffected = filesAffectedFromDiff(diff);
      try {
        applyPatch(repoRoot, diff);
      } catch (error) {
        const reason = error instanceof GitOperationError ? error.message : String(error);
        appendPatchEvent(patch, 'branch_created', {
          branch: branchName,
          patchId: patch.id,
          applied: false,
          reason,
        });
        store.update(patch.id, { status: 'branch_created' });
        deps.ui.warn(deps.t('branch.applied-failed', { branchName, reason }));
        return;
      }

      appendPatchEvent(patch, 'branch_created', {
        branch: branchName,
        patchId: patch.id,
        applied: true,
        filesAffected,
      });
      store.update(patch.id, { status: 'branch_created' });
      const files =
        filesAffected.length > 0 ? filesAffected.join(', ') : deps.t('branch.no-files-detected');
      deps.ui.success(deps.t('branch.applied-success', { branchName, files }));
    });
}
