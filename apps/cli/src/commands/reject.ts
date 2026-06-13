import { PatchStore } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { appendPatchEvent, resolvePatch } from '../lib/patches';

/** `excalibur reject [id]` — marks a patch proposal as rejected. */
export function registerRejectCommand(program: Command, deps: CliDeps): void {
  program
    .command('reject')
    .description('reject a proposed patch')
    .argument('[id]', 'patch id (defaults to the latest patch)')
    .action(async (id: string | undefined) => {
      const patch = resolvePatch(deps, id);
      appendPatchEvent(patch, 'approval_rejected', {
        patchId: patch.id,
        reason: 'rejected via excalibur reject',
      });
      new PatchStore(deps.cwd()).update(patch.id, {
        status: 'rejected',
        completedAt: new Date().toISOString(),
      });
      deps.ui.success(`Patch ${patch.id} rejected.`);
    });
}
