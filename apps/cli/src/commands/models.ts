import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { loadGatewayContext, providerNames } from '../lib/context';
import { runConnectionTest } from '../lib/connection-test';
import { promptProviderSetup, repoSelectKeymap, writeProvidersFile } from '../lib/provider-setup';

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
            ? deps.t('models.status-built-in')
            : config?.apiKeyEnv !== undefined && config.apiKeyEnv.length > 0
              ? deps.t('models.status-ready-set', { apiKeyEnv: config.apiKeyEnv })
              : deps.t('models.status-ready');
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
        deps.ui.info(deps.t('models.list-none'));
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
      const providers = await promptProviderSetup(deps, {
        yes: options.yes === true,
        keymap: repoSelectKeymap(deps),
      });
      if (providers === null) {
        deps.ui.info(deps.t('models.setup-skipped'));
        return;
      }
      const filePath = writeProvidersFile(deps.cwd(), providers);
      deps.ui.success(deps.t('models.setup-wrote', { filePath }));
      deps.ui.info(deps.t('models.setup-keys-note'));

      // Offer a live connection check so onboarding ends with confidence, not a
      // guess. Skipped non-interactively and for the offline mock; a failure is
      // surfaced as guidance (it never aborts a successful setup write).
      const defaultName = providers.providers.default;
      const chosen = typeof defaultName === 'string' ? providers.providers[defaultName] : undefined;
      if (deps.ui.isInteractive() && chosen?.type !== 'mock') {
        const test = await deps.ui.confirm(deps.t('models.setup-test-confirm'), {
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
