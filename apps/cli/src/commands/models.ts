import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { loadGatewayContext, providerNames } from '../lib/context';
import { promptProviderSetup, writeProvidersFile } from '../lib/provider-setup';

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
    });
}
