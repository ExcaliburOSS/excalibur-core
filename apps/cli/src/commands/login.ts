import { RunManager } from '@excalibur/core';
import {
  EXCALIBUR_API_KEY_ENV,
  EXCALIBUR_BASE_URL_ENV,
  HttpEnterpriseSyncClient,
  getCredentialsFilePath,
  loadCliCredentials,
  saveCliCredentials,
} from '@excalibur/enterprise-sync';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';

/**
 * Enterprise sync hooks (OSS spec §13) — EXPERIMENTAL in M1. Without login
 * everything stays local; sync is optional and transparent.
 */

const EXPERIMENTAL_NOTE =
  'Experimental: the Excalibur Enterprise control plane is not public yet. ' +
  'Everything keeps working locally without an account.';

function resolveCredentials(deps: CliDeps): { baseUrl: string; apiKey: string } | null {
  const credentials = loadCliCredentials({
    baseDir: deps.homeDir(),
    env: deps.env as Record<string, string | undefined>,
  });
  return credentials;
}

/** Pushes a finished run to Enterprise (used by `sync` and `run --sync`). */
export async function pushLatestRun(deps: CliDeps, runId?: string): Promise<void> {
  deps.ui.warn(EXPERIMENTAL_NOTE);
  const credentials = resolveCredentials(deps);
  if (credentials === null) {
    deps.ui.info(
      `Not connected. Run \`excalibur login\` first (or set ${EXCALIBUR_BASE_URL_ENV} and ${EXCALIBUR_API_KEY_ENV}).`,
    );
    return;
  }
  const runManager = new RunManager(deps.cwd());
  const run = runId !== undefined ? runManager.getRun(runId) : runManager.latestRun();
  if (run === null) {
    deps.ui.info('No local runs to sync yet. Create one with: excalibur run "<task>"');
    return;
  }
  const client = new HttpEnterpriseSyncClient(credentials);
  await client.pushRun(run);
  for (const event of runManager.readEvents(run.id)) {
    await client.pushEvent(event);
  }
  deps.ui.success(`Synced run ${run.id} to ${credentials.baseUrl}.`);
}

export function registerLoginCommands(program: Command, deps: CliDeps): void {
  program
    .command('login')
    .description('connect this machine to Excalibur Enterprise (experimental)')
    .option('--base-url <url>', 'Enterprise base URL')
    .option('--api-key <key>', 'Enterprise API key (stored with mode 0600)')
    .option('-y, --yes', 'skip prompts and accept defaults')
    .action(async (options: { baseUrl?: string; apiKey?: string; yes?: boolean }) => {
      deps.ui.warn(EXPERIMENTAL_NOTE);
      const baseUrl =
        options.baseUrl ??
        (await deps.ui.ask('Enterprise base URL (e.g. https://excalibur.your-company.com):', {
          yes: options.yes,
          defaultAnswer: '',
        }));
      if (baseUrl.trim().length === 0) {
        throw new CliUsageError(
          'An Enterprise base URL is required. Pass --base-url <url> or answer the prompt.',
        );
      }
      const apiKey =
        options.apiKey ??
        (await deps.ui.ask('API key (stored locally with file mode 0600):', {
          yes: options.yes,
          defaultAnswer: '',
        }));
      if (apiKey.trim().length === 0) {
        throw new CliUsageError(
          'An API key is required. Pass --api-key <key> or answer the prompt.',
        );
      }
      const filePath = saveCliCredentials(
        { baseUrl, apiKey },
        { baseDir: deps.homeDir() },
      );
      deps.ui.success(`Credentials saved to ${filePath} (mode 0600).`);
      deps.ui.info(
        `Environment variables ${EXCALIBUR_BASE_URL_ENV} / ${EXCALIBUR_API_KEY_ENV} take precedence when set.`,
      );
    });

  program
    .command('connect')
    .description('show the Enterprise connection status (experimental)')
    .action(() => {
      deps.ui.warn(EXPERIMENTAL_NOTE);
      const credentials = resolveCredentials(deps);
      if (credentials === null) {
        deps.ui.info(
          `Not connected. Run \`excalibur login\`, or set ${EXCALIBUR_BASE_URL_ENV} and ${EXCALIBUR_API_KEY_ENV}.`,
        );
        return;
      }
      deps.ui.success(`Connected to ${credentials.baseUrl}.`);
      deps.ui.info(`Credentials file: ${getCredentialsFilePath(deps.homeDir())}`);
    });

  program
    .command('sync')
    .description('push the latest local run to Excalibur Enterprise (experimental)')
    .argument('[runId]', 'run to push (defaults to the latest run)')
    .action(async (runId: string | undefined) => {
      await pushLatestRun(deps, runId);
    });
}
