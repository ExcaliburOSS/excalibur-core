import { getLocalDiff, type AdditionalContextSource } from '@excalibur/core';
import {
  createLspSession,
  languageForFile,
  PermissionEngine,
  resolveBinary,
  resolveServerFor,
} from '@excalibur/agent-runtime';
import {
  DEFAULT_LSP_CONFIG,
  type DiagnosticsPayload,
  type ExcaliburConfig,
} from '@excalibur/shared';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import {
  buildNeighborContext,
  deriveNeighborQuery,
  loadConfigContext,
  readUserSuppliedFile,
  redactDiff,
} from '../lib/context';
import {
  diagnosticsContextSource,
  lspDiagnosticsContextSource,
  runDiagnostics,
} from '../lib/diagnostics';
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
    .option('--diagnostics', 'run the repo typecheck and anchor the review on its real errors')
    .option('--no-stream', 'disable live streaming of the answer')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(
      async (
        relPath: string | undefined,
        options: {
          diff?: boolean;
          context?: boolean;
          diagnostics?: boolean;
          stream?: boolean;
          yes?: boolean;
        },
      ) => {
        let prompt: string;
        let input: string;
        let additionalSources: AdditionalContextSource[] = [];
        let changedFiles: string[] = [];
        const retrieve = options.context !== false;

        if (relPath !== undefined && options.diff !== true) {
          // Blocked-path enforcement + secret redaction (Build Contract §4.4):
          // `excalibur review src/secrets/keys.ts` is refused, not slurped.
          const content = await readUserSuppliedFile(deps, deps.cwd(), relPath, {
            yes: options.yes,
          });
          prompt = `Review the file \`${relPath}\`:\n\n\`\`\`\n${content}\n\`\`\``;
          input = `Review ${relPath}`;
          changedFiles = [relPath];
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
            deps.ui.success(deps.t('review.cleanTree'));
            return;
          }
          // Redact secrets from the diff before it reaches the prompt or disk —
          // staged changes routinely include leaked credentials.
          const redactedDiff = redactDiff(diff);
          prompt = `Review this local diff:\n\n\`\`\`diff\n${redactedDiff}\n\`\`\``;
          input = 'Review the local working-tree diff';
          changedFiles = filesAffectedFromDiff(redactedDiff);
          if (retrieve) {
            additionalSources = await neighborContextForChangedFiles(deps, redactedDiff);
          }
        }

        // Real compiler diagnostics (M3, opt-in): PREFER a diff-scoped language
        // server over the changed files (fast, per-file); fall back to the
        // whole-repo typecheck command when no LSP server is available.
        if (options.diagnostics === true) {
          const config = loadConfigContext(deps.cwd()).config;
          const lsp = await lspDiagnosticsForReview(deps, config, changedFiles);
          if (lsp.status === 'found') {
            additionalSources = [...additionalSources, lsp.source];
            deps.ui.warn(deps.t('review.typecheckErrors', { count: lsp.errorCount || 'some' }));
          } else if (lsp.status === 'clean') {
            deps.ui.success(deps.t('review.typecheckClean'));
          } else {
            // No LSP server installed — fall back to the repo typecheck command.
            const typecheck = config.commands?.typecheck;
            if (typecheck === undefined) {
              deps.ui.warn(deps.t('review.noTypecheck'));
            } else {
              deps.ui.info(deps.t('review.runningDiagnostics', { typecheck }));
              const result = runDiagnostics(deps.cwd(), typecheck);
              const source = diagnosticsContextSource(result);
              if (source !== null) {
                additionalSources = [...additionalSources, source];
                deps.ui.warn(
                  deps.t('review.typecheckErrors', { count: result.diagnostics.length || 'some' }),
                );
              } else if (result.ok === true) {
                deps.ui.success(deps.t('review.typecheckClean'));
              }
            }
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

/** Diff-scoped LSP diagnostics outcome: errors found, clean, or no server. */
type LspReviewResult =
  | { status: 'unavailable' }
  | { status: 'clean' }
  | { status: 'found'; source: AdditionalContextSource; errorCount: number };

/**
 * Runs a diff-scoped language server over the supported, permission-allowed
 * changed files and builds a precedence-6 context source. Returns `unavailable`
 * (→ the caller falls back to the whole-repo typecheck) when LSP is disabled or
 * no server binary is installed for the changed files' languages; `clean` when
 * the server ran but found nothing; `found` with the source otherwise. The
 * session is always closed.
 */
async function lspDiagnosticsForReview(
  deps: CliDeps,
  config: ExcaliburConfig,
  changedFiles: ReadonlyArray<string>,
): Promise<LspReviewResult> {
  const lspCfg = config.lsp;
  if (lspCfg?.enabled === false) {
    return { status: 'unavailable' };
  }
  // Supported language + readable (blocked paths are never opened for diagnostics).
  const permissions = new PermissionEngine(config.permissions);
  const targets = changedFiles.filter(
    (path) => languageForFile(path) !== null && permissions.checkPath(path, 'read').allowed,
  );
  if (targets.length === 0) {
    return { status: 'unavailable' };
  }
  // Is a server actually installed for any target's language? If not, fall back.
  const serverAvailable = targets.some((path) => {
    const language = languageForFile(path);
    const server = language === null ? null : resolveServerFor(language, lspCfg?.servers);
    return server !== null && resolveBinary(server.command) !== null;
  });
  if (!serverAvailable) {
    return { status: 'unavailable' };
  }

  const session = createLspSession({ workdir: deps.cwd(), config: lspCfg ?? DEFAULT_LSP_CONFIG });
  try {
    const payloads: DiagnosticsPayload[] = [];
    for (const path of targets) {
      const diag = await session.diagnosticsFor(path);
      if (diag !== null) payloads.push(diag);
    }
    const source = lspDiagnosticsContextSource(payloads);
    if (source === null) {
      return { status: 'clean' };
    }
    const errorCount = payloads.reduce((total, p) => total + p.errorCount, 0);
    return { status: 'found', source, errorCount };
  } finally {
    session.close();
  }
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
