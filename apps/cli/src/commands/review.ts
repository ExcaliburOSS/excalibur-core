import { getLocalDiff } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { readUserSuppliedFile, redactDiff } from '../lib/context';
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
    .action(async (relPath: string | undefined, options: { diff?: boolean; yes?: boolean }) => {
      let prompt: string;
      let input: string;

      if (relPath !== undefined && options.diff !== true) {
        // Blocked-path enforcement + secret redaction (Build Contract §4.4):
        // `excalibur review src/secrets/keys.ts` is refused, not slurped.
        const content = await readUserSuppliedFile(deps, deps.cwd(), relPath, { yes: options.yes });
        prompt = `Review the file \`${relPath}\`:\n\n\`\`\`\n${content}\n\`\`\``;
        input = `Review ${relPath}`;
      } else {
        const diff = getLocalDiff(deps.cwd());
        if (diff.trim().length === 0) {
          deps.ui.success('Working tree is clean — nothing to review.');
          return;
        }
        // Redact secrets from the diff before it reaches the prompt or disk —
        // staged changes routinely include leaked credentials.
        prompt = `Review this local diff:\n\n\`\`\`diff\n${redactDiff(diff)}\n\`\`\``;
        input = 'Review the local working-tree diff';
      }

      await runInteractionCommand(deps, { command: 'review', kind: 'review', input, prompt });
    });
}
