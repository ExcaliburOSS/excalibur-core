import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLocalDiff } from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { runInteractionCommand } from '../lib/interactions';

/**
 * `excalibur review [path] [--diff]` — Level 0 review interaction
 * (COMMAND_DEFAULTS: review → review-only, L0). Reviews a file or the local
 * working-tree diff; never changes code.
 */
export function registerReviewCommand(program: Command, deps: CliDeps): void {
  program
    .command('review')
    .description('review a file or the local diff (Level 0 — Review)')
    .argument('[path]', 'file to review (defaults to the local diff)')
    .option('--diff', 'review the local working-tree diff')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (relPath: string | undefined, options: { diff?: boolean }) => {
      let prompt: string;
      let input: string;

      if (relPath !== undefined && options.diff !== true) {
        const filePath = join(deps.cwd(), relPath);
        if (!existsSync(filePath)) {
          throw new CliUsageError(`File not found: ${relPath}`);
        }
        const content = readFileSync(filePath, 'utf8');
        prompt = `Review the file \`${relPath}\`:\n\n\`\`\`\n${content}\n\`\`\``;
        input = `Review ${relPath}`;
      } else {
        const diff = getLocalDiff(deps.cwd());
        if (diff.trim().length === 0) {
          deps.ui.success('Working tree is clean — nothing to review.');
          return;
        }
        prompt = `Review this local diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;
        input = 'Review the local working-tree diff';
      }

      await runInteractionCommand(deps, { command: 'review', kind: 'review', input, prompt });
    });
}
