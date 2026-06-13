import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { readUserSuppliedFile } from '../lib/context';
import { runInteractionCommand } from '../lib/interactions';

/**
 * `excalibur ask "<question>" [--file <path>]` — Level 1 assistant
 * interaction over the repository (COMMAND_DEFAULTS: ask → ask-repo, L1).
 * Never changes code; writes an InteractionStore artifact (ONB-8).
 */
export function registerAskCommand(program: Command, deps: CliDeps): void {
  program
    .command('ask')
    .description('ask a question about the repository (Level 1 — Assist)')
    .argument('<question...>', 'the question to ask')
    .option('--file <path>', 'include a file as additional context')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (questionWords: string[], options: { file?: string; yes?: boolean }) => {
      const question = questionWords.join(' ').trim();
      if (question.length === 0) {
        throw new CliUsageError('The question must not be empty.');
      }

      let prompt = question;
      let input = question;
      if (options.file !== undefined) {
        // Blocked-path enforcement + secret redaction (Build Contract §4.4):
        // `excalibur ask "..." --file .env` is refused, not slurped.
        const content = await readUserSuppliedFile(deps, deps.cwd(), options.file, {
          yes: options.yes,
        });
        prompt = `${question}\n\nFile \`${options.file}\`:\n\n\`\`\`\n${content}\n\`\`\``;
        input = `${question}\n\n(Context file: ${options.file})`;
      }

      await runInteractionCommand(deps, { command: 'ask', kind: 'ask', input, prompt });
    });
}
