import { PatchStore } from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { generatePatch } from '../lib/interactions';
import { appendPatchEvent } from '../lib/patches';

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
        throw new CliUsageError('The task must not be empty.');
      }

      const patch = await generatePatch(deps, task);

      const apply = await deps.ui.confirm('Apply patch?', {
        yes: options.yes,
        defaultYes: false,
      });
      if (apply) {
        appendPatchEvent(patch, 'patch_applied', { simulated: true, patchId: patch.id });
        new PatchStore(deps.cwd()).update(patch.id, {
          status: 'applied',
          completedAt: new Date().toISOString(),
        });
        deps.ui.success(
          `Patch ${patch.id} marked as applied (simulated — M1 never modifies your files).`,
        );
      } else {
        deps.ui.info(
          `Next: excalibur apply ${patch.id} · excalibur branch ${patch.id} · excalibur reject ${patch.id}`,
        );
      }
    });
}
