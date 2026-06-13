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
          `Cannot create branch ${branchName}: ${repoRoot} is not a git repository. Run \`git init\` first.`,
        );
      }

      const store = new PatchStore(repoRoot);
      const diff = store.readArtifact(patch.id, 'diff.patch') ?? '';
      if (diff.trim().length === 0) {
        throw new CliUsageError(
          `Patch ${patch.id} has an empty diff — nothing to apply onto a branch. Regenerate it with \`excalibur patch "<task>"\`.`,
        );
      }

      const confirmed =
        options.yes === true ||
        (await deps.ui.confirm(`Create git branch ${branchName} and apply the patch onto it?`, {
          defaultYes: false,
        }));
      if (!confirmed) {
        deps.ui.info('Branch creation cancelled.');
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
        deps.ui.warn(
          `Created branch ${branchName}, but the patch did not apply: ${reason}. ` +
            `You are on ${branchName}; resolve it manually or regenerate the patch.`,
        );
        return;
      }

      appendPatchEvent(patch, 'branch_created', {
        branch: branchName,
        patchId: patch.id,
        applied: true,
        filesAffected,
      });
      store.update(patch.id, { status: 'branch_created' });
      deps.ui.success(
        `Created branch ${branchName} and applied the patch (${
          filesAffected.length > 0 ? filesAffected.join(', ') : 'no files detected'
        }).`,
      );
    });
}
