import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { buildNeighborContext, deriveNeighborQuery, readUserSuppliedFile } from '../lib/context';
import { runInteractionCommand } from '../lib/interactions';

/**
 * `excalibur explain <path>` — explains a file (Level 1 assistant
 * interaction; never changes code). Writes an InteractionStore artifact.
 *
 * M2: pulls permission-gated neighbor context (same-dir + imported files) via
 * deterministic retrieval anchored on the target, so the explanation can
 * reference the surrounding code. `--no-context` skips retrieval.
 */
export function registerExplainCommand(program: Command, deps: CliDeps): void {
  program
    .command('explain')
    .description('explain a source file (Level 1 — Assist)')
    .argument('<path>', 'file to explain')
    .option('--no-context', 'skip neighbor-context retrieval')
    .option('--no-stream', 'disable live streaming of the answer')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(
      async (relPath: string, options: { context?: boolean; stream?: boolean; yes?: boolean }) => {
        // Blocked-path enforcement + secret redaction (Build Contract §4.4):
        // `excalibur explain .env` is refused, not slurped into the prompt.
        const content = await readUserSuppliedFile(deps, deps.cwd(), relPath, { yes: options.yes });
        const prompt = `Explain the file \`${relPath}\`:\n\n\`\`\`\n${content}\n\`\`\``;

        const additionalSources =
          options.context === false
            ? []
            : await buildNeighborContext(
                deps,
                deps.cwd(),
                relPath,
                deriveNeighborQuery(relPath, content),
              );

        await runInteractionCommand(deps, {
          command: 'explain',
          kind: 'explain',
          input: `Explain ${relPath}`,
          prompt,
          additionalSources,
          noStream: options.stream === false,
        });
      },
    );
}
