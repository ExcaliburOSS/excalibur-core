import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { readUserSuppliedFile } from '../lib/context';
import { runInteractionCommand } from '../lib/interactions';

/**
 * `excalibur explain <path>` — explains a file (Level 1 assistant
 * interaction; never changes code). Writes an InteractionStore artifact.
 */
export function registerExplainCommand(program: Command, deps: CliDeps): void {
  program
    .command('explain')
    .description('explain a source file (Level 1 — Assist)')
    .argument('<path>', 'file to explain')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (relPath: string, options: { yes?: boolean }) => {
      // Blocked-path enforcement + secret redaction (Build Contract §4.4):
      // `excalibur explain .env` is refused, not slurped into the prompt.
      const content = await readUserSuppliedFile(deps, deps.cwd(), relPath, { yes: options.yes });
      const prompt = `Explain the file \`${relPath}\`:\n\n\`\`\`\n${content}\n\`\`\``;
      await runInteractionCommand(deps, {
        command: 'explain',
        kind: 'explain',
        input: `Explain ${relPath}`,
        prompt,
      });
    });
}
