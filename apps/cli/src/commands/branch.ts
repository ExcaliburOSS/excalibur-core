import { PatchStore, createBranch } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { appendPatchEvent, resolvePatch } from '../lib/patches';

/**
 * `excalibur branch [id]` — creates a REAL local git branch named
 * `excalibur/<id>` for a patch (the only git mutation the M1 CLI performs).
 */
export function registerBranchCommand(program: Command, deps: CliDeps): void {
  program
    .command('branch')
    .description('create a git branch excalibur/<id> for a patch')
    .argument('[id]', 'patch id (defaults to the latest patch)')
    .option('-y, --yes', 'create the branch without prompting')
    .action(async (id: string | undefined, options: { yes?: boolean }) => {
      const patch = resolvePatch(deps, id);
      const branchName = `excalibur/${patch.id}`;
      const confirmed =
        options.yes === true ||
        (await deps.ui.confirm(`Create git branch ${branchName}?`, { defaultYes: false }));
      if (!confirmed) {
        deps.ui.info('Branch creation cancelled.');
        return;
      }
      createBranch(deps.cwd(), branchName);
      appendPatchEvent(patch, 'branch_created', { branch: branchName, patchId: patch.id });
      new PatchStore(deps.cwd()).update(patch.id, { status: 'branch_created' });
      deps.ui.success(`Created branch ${branchName}.`);
      deps.ui.info(
        'The patch itself is not applied automatically in M1 — apply the diff manually or wait for M2.',
      );
    });
}
