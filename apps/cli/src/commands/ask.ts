import { existsSync, readFileSync } from 'node:fs';
import {
  askStructured,
  buildRepoContextSources,
  type AdditionalContextSource,
  type JsonSchema,
} from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import {
  buildEffectiveContext,
  loadGatewayContext,
  readUserSuppliedFile,
  requireConfiguredModel,
} from '../lib/context';
import { runInteractionCommand } from '../lib/interactions';

/** Loads a JSON schema from a file path or an inline JSON string. */
function loadSchema(value: string): JsonSchema {
  const text = existsSync(value) ? readFileSync(value, 'utf8') : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliUsageError(
      `--json-schema is neither a readable file nor valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CliUsageError('--json-schema must be a JSON object (a JSON Schema).');
  }
  return parsed as JsonSchema;
}

/**
 * `excalibur ask "<question>" [--file <path>]` — Level 1 assistant
 * interaction over the repository (COMMAND_DEFAULTS: ask → ask-repo, L1).
 * Never changes code; writes an InteractionStore artifact (ONB-8).
 *
 * M2: before building the effective context, deterministic repo retrieval
 * (`buildRepoContextSources`) pulls the most relevant code into the prompt.
 * `--no-context` skips it; `--context-files <n>` bounds the file count; `--file`
 * still adds the named file verbatim AND augments with retrieval.
 */
export function registerAskCommand(program: Command, deps: CliDeps): void {
  program
    .command('ask')
    .description('ask a question about the repository (Level 1 — Assist)')
    .argument('<question...>', 'the question to ask')
    .option('--file <path>', 'include a file as additional context')
    .option('--no-context', 'skip automatic repo-context retrieval')
    .option('--context-files <n>', 'max files to retrieve as context', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--no-stream', 'disable live streaming of the answer')
    .option(
      '--json-schema <schema>',
      'constrain the answer to a JSON Schema (file path or inline JSON); prints JSON',
    )
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(
      async (
        questionWords: string[],
        options: {
          file?: string;
          context?: boolean;
          contextFiles?: number;
          stream?: boolean;
          jsonSchema?: string;
          yes?: boolean;
        },
      ) => {
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

        // commander sets `--no-context` → context: false; default is undefined.
        let additionalSources: AdditionalContextSource[] = [];
        if (options.context !== false) {
          additionalSources = await buildRepoContextSources({
            repoRoot: deps.cwd(),
            query: question,
            ...(options.contextFiles !== undefined && !Number.isNaN(options.contextFiles)
              ? { maxFiles: options.contextFiles }
              : {}),
          });
        }

        // Structured output: constrain the answer to a JSON Schema and print
        // JSON (provider-agnostic — instruct + validate + one re-prompt). Exits
        // non-zero if the model can't conform, so CI can rely on it.
        if (options.jsonSchema !== undefined) {
          const schema = loadSchema(options.jsonSchema);
          const gateway = loadGatewayContext(deps.cwd());
          requireConfiguredModel(gateway, deps.t);
          const effective = await buildEffectiveContext(deps, deps.cwd(), {
            workflowId: 'ask-repo',
            autonomyLevel: 1,
            ...(additionalSources.length > 0 ? { additionalSources } : {}),
          });
          const result = await askStructured(gateway.gateway, {
            question: prompt,
            schema,
            ...(effective.instructionsMarkdown.length > 0
              ? { systemContext: effective.instructionsMarkdown }
              : {}),
            provider: gateway.providerName,
          });
          deps.ui.json(result.value ?? null);
          if (result.errors.length > 0) {
            deps.ui.error(deps.t('ask.schema-invalid', { errors: result.errors.join('; ') }));
            process.exitCode = 1;
          }
          return;
        }

        await runInteractionCommand(deps, {
          command: 'ask',
          kind: 'ask',
          input,
          prompt,
          additionalSources,
          noStream: options.stream === false,
        });
      },
    );
}
