import { getLocalDiff, type AdditionalContextSource } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import {
  buildNeighborContext,
  deriveNeighborQuery,
  readUserSuppliedFile,
  redactDiff,
} from '../lib/context';
import { filesAffectedFromDiff, runInteractionCommand } from '../lib/interactions';

/**
 * `excalibur review [path] [--diff]` — Level 0 review interaction
 * (COMMAND_DEFAULTS: review → review-only, L0). Reviews a file or the local
 * working-tree diff; never changes code.
 *
 * M2: a file review pulls permission-gated neighbor context; a `--diff` review
 * injects retrieval/neighbor context for each changed path (also gated). The
 * redacted diff itself remains the user prompt. `--no-context` skips retrieval.
 */
export function registerReviewCommand(program: Command, deps: CliDeps): void {
  program
    .command('review')
    .description('review a file or the local diff (Level 0 — Review)')
    .argument('[path]', 'file to review (defaults to the local diff)')
    .option('--diff', 'review the local working-tree diff')
    .option('--no-context', 'skip neighbor-context retrieval')
    .option('--no-stream', 'disable live streaming of the answer')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(
      async (
        relPath: string | undefined,
        options: { diff?: boolean; context?: boolean; stream?: boolean; yes?: boolean },
      ) => {
        let prompt: string;
        let input: string;
        let additionalSources: AdditionalContextSource[] = [];
        const retrieve = options.context !== false;

        if (relPath !== undefined && options.diff !== true) {
          // Blocked-path enforcement + secret redaction (Build Contract §4.4):
          // `excalibur review src/secrets/keys.ts` is refused, not slurped.
          const content = await readUserSuppliedFile(deps, deps.cwd(), relPath, {
            yes: options.yes,
          });
          prompt = `Review the file \`${relPath}\`:\n\n\`\`\`\n${content}\n\`\`\``;
          input = `Review ${relPath}`;
          if (retrieve) {
            additionalSources = await buildNeighborContext(
              deps,
              deps.cwd(),
              relPath,
              deriveNeighborQuery(relPath, content),
            );
          }
        } else {
          const diff = getLocalDiff(deps.cwd());
          if (diff.trim().length === 0) {
            deps.ui.success('Working tree is clean — nothing to review.');
            return;
          }
          // Redact secrets from the diff before it reaches the prompt or disk —
          // staged changes routinely include leaked credentials.
          const redactedDiff = redactDiff(diff);
          prompt = `Review this local diff:\n\n\`\`\`diff\n${redactedDiff}\n\`\`\``;
          input = 'Review the local working-tree diff';
          if (retrieve) {
            additionalSources = await neighborContextForChangedFiles(deps, redactedDiff);
          }
        }

        await runInteractionCommand(deps, {
          command: 'review',
          kind: 'review',
          input,
          prompt,
          additionalSources,
          noStream: options.stream === false,
        });
      },
    );
}

/**
 * Injects permission-gated neighbor context for every file touched by the
 * diff. Each changed path anchors a deterministic retrieval; the per-file
 * results are merged and de-duplicated by source label. All paths flow through
 * the same `PermissionEngine` gate as the single-file path.
 */
async function neighborContextForChangedFiles(
  deps: CliDeps,
  redactedDiff: string,
): Promise<AdditionalContextSource[]> {
  const changed = filesAffectedFromDiff(redactedDiff);
  const merged = new Map<string, AdditionalContextSource>();
  for (const path of changed) {
    const query = `${path.split('/').pop() ?? path}`;
    const sources = await buildNeighborContext(deps, deps.cwd(), path, query, { maxFiles: 3 });
    for (const source of sources) {
      if (!merged.has(source.path)) {
        merged.set(source.path, source);
      }
    }
  }
  return [...merged.values()];
}
