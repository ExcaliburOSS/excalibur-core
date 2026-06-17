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

function resolveCredentials(deps: CliDeps): { baseUrl: string; apiKey: string } | null {
  const credentials = loadCliCredentials({
    baseDir: deps.homeDir(),
    env: deps.env as Record<string, string | undefined>,
  });
  return credentials;
}

/** Pushes a finished run to Enterprise (used by `sync` and `run --sync`). */
export async function pushLatestRun(deps: CliDeps, runId?: string): Promise<void> {
  deps.ui.warn(deps.t('login.experimental-note'));
  const credentials = resolveCredentials(deps);
  if (credentials === null) {
    deps.ui.info(
      deps.t('login.not-connected-sync', {
        baseUrlEnv: EXCALIBUR_BASE_URL_ENV,
        apiKeyEnv: EXCALIBUR_API_KEY_ENV,
      }),
    );
    return;
  }
  const runManager = new RunManager(deps.cwd());
  const run = runId !== undefined ? runManager.getRun(runId) : runManager.latestRun();
  if (run === null) {
    deps.ui.info(deps.t('login.no-local-runs'));
    return;
  }
  const client = new HttpEnterpriseSyncClient(credentials);
  await client.pushRun(run);
  for (const event of runManager.readEvents(run.id)) {
    await client.pushEvent(event);
  }
  deps.ui.success(deps.t('login.synced', { runId: run.id, baseUrl: credentials.baseUrl }));
}

export function registerLoginCommands(program: Command, deps: CliDeps): void {
  program
    .command('login')
    .description('connect this machine to Excalibur Enterprise (experimental)')
    .option('--base-url <url>', 'Enterprise base URL')
    .option('--api-key <key>', 'Enterprise API key (stored with mode 0600)')
    .option('-y, --yes', 'skip prompts and accept defaults')
    .action(async (options: { baseUrl?: string; apiKey?: string; yes?: boolean }) => {
      deps.ui.warn(deps.t('login.experimental-note'));
      const baseUrl =
        options.baseUrl ??
        (await deps.ui.ask(deps.t('login.ask-base-url'), {
          yes: options.yes,
          defaultAnswer: '',
        }));
      if (baseUrl.trim().length === 0) {
        throw new CliUsageError(deps.t('login.base-url-required'));
      }
      const apiKey =
        options.apiKey ??
        (await deps.ui.ask(deps.t('login.ask-api-key'), {
          yes: options.yes,
          defaultAnswer: '',
        }));
      if (apiKey.trim().length === 0) {
        throw new CliUsageError(deps.t('login.api-key-required'));
      }
      const filePath = saveCliCredentials(
        { baseUrl, apiKey },
        { baseDir: deps.homeDir() },
      );
      deps.ui.success(deps.t('login.credentials-saved', { filePath }));
      deps.ui.info(
        deps.t('login.env-precedence', {
          baseUrlEnv: EXCALIBUR_BASE_URL_ENV,
          apiKeyEnv: EXCALIBUR_API_KEY_ENV,
        }),
      );
    });

  program
    .command('connect')
    .description('show the Enterprise connection status (experimental)')
    .action(() => {
      deps.ui.warn(deps.t('login.experimental-note'));
      const credentials = resolveCredentials(deps);
      if (credentials === null) {
        deps.ui.info(
          deps.t('login.not-connected-status', {
            baseUrlEnv: EXCALIBUR_BASE_URL_ENV,
            apiKeyEnv: EXCALIBUR_API_KEY_ENV,
          }),
        );
        return;
      }
      deps.ui.success(deps.t('login.connected', { baseUrl: credentials.baseUrl }));
      deps.ui.info(deps.t('login.credentials-file', { path: getCredentialsFilePath(deps.homeDir()) }));
    });

  program
    .command('sync')
    .description('push the latest local run to Excalibur Enterprise (experimental)')
    .argument('[runId]', 'run to push (defaults to the latest run)')
    .action(async (runId: string | undefined) => {
      await pushLatestRun(deps, runId);
    });
}
