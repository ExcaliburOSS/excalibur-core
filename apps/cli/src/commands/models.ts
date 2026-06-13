import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { loadGatewayContext, providerNames } from '../lib/context';
import { promptProviderSetup, writeProvidersFile } from '../lib/provider-setup';

/**
 * `excalibur models list|setup` — provider configuration. API keys are
 * referenced by environment variable NAME only; real providers are flagged
 * "available in M2" (the M1 gateway only executes the built-in mock).
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
        const status = config?.type === 'mock' ? 'ready (built-in)' : 'available in M2';
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
          'No .excalibur/models/providers.yaml — using the built-in defaults. Run `excalibur models setup` to configure.',
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
    .option('-y, --yes', 'skip prompts (selects the built-in mock — the M1 default)')
    .action(async (options: { yes?: boolean }) => {
      const providers = await promptProviderSetup(deps, { yes: options.yes === true });
      if (providers === null) {
        deps.ui.info(
          'Provider setup skipped. Commands keep using the built-in mock provider; run `excalibur models setup` anytime.',
        );
        return;
      }
      const filePath = writeProvidersFile(deps.cwd(), providers);
      deps.ui.success(`Wrote ${filePath}`);
      deps.ui.info('API keys are read from environment variables at call time — never stored.');
    });
}
