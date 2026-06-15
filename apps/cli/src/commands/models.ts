import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import {
  chatWithGuidance,
  loadGatewayContext,
  providerNames,
  requireConfiguredModel,
} from '../lib/context';
import { CliUsageError } from '../errors';
import { promptProviderSetup, writeProvidersFile } from '../lib/provider-setup';

/**
 * Sends a tiny request to the resolved default provider and reports whether it
 * answered (latency + tokens). Throws a {@link CliUsageError} on failure so the
 * caller sees actionable guidance instead of a stack trace. Shared by the
 * `models test` command and the optional post-`setup` connection check.
 */
async function runConnectionTest(deps: CliDeps): Promise<void> {
  const context = loadGatewayContext(deps.cwd());
  requireConfiguredModel(context); // refuses with setup guidance when unconfigured
  const config = context.providers.providers[context.providerName];
  const modelLabel =
    config?.model !== undefined && config.model.length > 0 ? ` (${config.model})` : '';
  if (config?.type === 'mock') {
    deps.ui.info(
      `Provider "${context.providerName}" is the offline mock — nothing to reach over the network. ` +
        'Configure a real provider with `excalibur models setup` to test a live connection.',
    );
    return;
  }
  deps.ui.info(`Testing provider "${context.providerName}"${modelLabel} — sending a tiny request…`);
  const startedAt = Date.now();
  try {
    const { output } = await chatWithGuidance(deps, context, {
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      maxTokens: 16,
      temperature: 0,
    });
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const reply = output.content.trim().replace(/\s+/g, ' ').slice(0, 60);
    const tokens = `${output.usage.inputTokens}→${output.usage.outputTokens} tok`;
    const cost = output.costCents !== null ? ` · ${output.costCents.toFixed(3)}¢` : '';
    deps.ui.success(
      `Connected — ${context.providerName}${modelLabel} responded in ${seconds}s · ${tokens}${cost}.`,
    );
    if (reply.length > 0) {
      deps.ui.info(`Reply: "${reply}"`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(
      `Could not reach provider "${context.providerName}"${modelLabel}: ${message} ` +
        'Check the API key env var is exported and the base URL/model are correct (`excalibur models list`).',
    );
  }
}

/**
 * `excalibur models list|setup` — provider configuration. API keys are
 * referenced by environment variable NAME only. Real providers execute (M2):
 * a configured provider is `ready` once its API key env var is set; the
 * the free default is local Ollama and Kimi K2 (Moonshot) is the recommended
 * paid option; the mock is for offline/tests only, never a runtime fallback.
 */
export function registerModelsCommand(program: Command, deps: CliDeps): void {
  const models = program.command('models').description('inspect and configure model providers');

  models
    .command('list')
    .description('list configured model providers')
    .option('--json', 'machine-readable JSON output')
    .action((options: { json?: boolean }) => {
      const context = loadGatewayContext(deps.cwd());
      const names = providerNames(context.providers);
      const rows = names.map((name) => {
        const config = context.providers.providers[name];
        const status =
          config?.type === 'mock'
            ? 'ready (built-in)'
            : config?.apiKeyEnv !== undefined && config.apiKeyEnv.length > 0
              ? `ready · set ${config.apiKeyEnv}`
              : 'ready';
        return {
          name,
          type: config?.type ?? 'unknown',
          baseUrl: config?.baseUrl ?? '',
          apiKeyEnv: config?.apiKeyEnv ?? '',
          default: name === context.providerName,
          status,
        };
      });
      if (options.json === true) {
        deps.ui.json(rows);
        return;
      }
      if (context.providersPath === null) {
        deps.ui.info(
          'No LLM provider configured. Run `excalibur models setup` — the free default is local Ollama; ' +
            'Kimi K2 (Moonshot) is the recommended paid option (bring your own key).',
        );
      }
      deps.ui.table(
        ['NAME', 'TYPE', 'BASE URL', 'KEY ENV', 'DEFAULT', 'STATUS'],
        rows.map((row) => [
          row.name,
          row.type,
          row.baseUrl,
          row.apiKeyEnv,
          row.default ? '✓' : '',
          row.status,
        ]),
      );
    });

  models
    .command('setup')
    .description('configure a model provider (env var names only, never key values)')
    .option('-y, --yes', 'skip prompts (writes the offline mock — for tests/CI, not a real model)')
    .action(async (options: { yes?: boolean }) => {
      const providers = await promptProviderSetup(deps, { yes: options.yes === true });
      if (providers === null) {
        deps.ui.info(
          'Provider setup skipped. Excalibur needs an LLM — run `excalibur models setup` anytime ' +
            '(free: local Ollama · recommended: Kimi K2 via Moonshot, BYOK).',
        );
        return;
      }
      const filePath = writeProvidersFile(deps.cwd(), providers);
      deps.ui.success(`Wrote ${filePath}`);
      deps.ui.info('API keys are read from environment variables at call time — never stored.');

      // Offer a live connection check so onboarding ends with confidence, not a
      // guess. Skipped non-interactively and for the offline mock; a failure is
      // surfaced as guidance (it never aborts a successful setup write).
      const defaultName = providers.providers.default;
      const chosen = typeof defaultName === 'string' ? providers.providers[defaultName] : undefined;
      if (deps.ui.isInteractive() && chosen?.type !== 'mock') {
        const test = await deps.ui.confirm('Test the connection now? (sends a tiny request)', {
          defaultYes: true,
        });
        if (test) {
          try {
            await runConnectionTest(deps);
          } catch (error) {
            deps.ui.warn(error instanceof Error ? error.message : String(error));
          }
        }
      }
    });

  models
    .command('test')
    .description('send a tiny request to the configured provider to confirm it works')
    .action(async () => {
      await runConnectionTest(deps);
    });
}
