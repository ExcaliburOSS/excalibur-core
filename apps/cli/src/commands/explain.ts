import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
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
    .action(async (relPath: string) => {
      const filePath = join(deps.cwd(), relPath);
      if (!existsSync(filePath)) {
        throw new CliUsageError(`File not found: ${relPath}`);
      }
      const content = readFileSync(filePath, 'utf8');
      const prompt = `Explain the file \`${relPath}\`:\n\n\`\`\`\n${content}\n\`\`\``;
      await runInteractionCommand(deps, {
        command: 'explain',
        kind: 'explain',
        input: `Explain ${relPath}`,
        prompt,
      });
    });
}
