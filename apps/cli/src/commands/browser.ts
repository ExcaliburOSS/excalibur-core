import {
  browserState,
  chromiumInstalled,
  installBrowser,
  removeBrowser,
} from '@excalibur/agent-runtime';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { readRawConfig, writeRawConfig } from '../lib/config-file';

/**
 * `excalibur browser` — manage the OPT-IN Tier-2 local browser (F4). `enable`
 * lazily installs Chromium (via Playwright) and flips `browser.enabled` so
 * `web_fetch`/`web_extract` escalate to a real headless render on JS-only/blocked
 * pages. FREE and unlimited once installed; nothing is downloaded until you ask.
 */
export function registerBrowserCommand(program: Command, deps: CliDeps): void {
  const browser = program
    .command('browser')
    .description('manage the opt-in local browser (renders JS-heavy pages for web_fetch)');

  function setEnabled(value: boolean): void {
    const repoRoot = deps.cwd();
    const raw = readRawConfig(repoRoot);
    const section =
      typeof raw['browser'] === 'object' && raw['browser'] !== null
        ? (raw['browser'] as Record<string, unknown>)
        : {};
    section['enabled'] = value;
    raw['browser'] = section;
    writeRawConfig(repoRoot, raw);
  }

  browser
    .command('enable')
    .description('install Chromium (once) and turn on browser escalation')
    .option('-y, --yes', 'skip the install confirmation prompt')
    .action(async (options: { yes?: boolean }) => {
      // Fast path first (a pure fs check) so we never spawn `npx` before the
      // user has consented — and so an already-installed Chromium enables instantly.
      if (!chromiumInstalled()) {
        const proceed = await deps.ui.confirm(deps.t('browser.install-consent'), {
          yes: options.yes === true,
          defaultYes: false,
        });
        if (!proceed) {
          deps.ui.info(deps.t('browser.cancelled'));
          return;
        }
        // Only now probe for Node (spawns `npx`) — install needs it anyway.
        if (browserState() === 'node-missing') {
          deps.ui.error(deps.t('browser.node-missing'));
          return;
        }
        deps.ui.info(deps.t('browser.installing'));
        const result = installBrowser();
        if (!result.ok) {
          deps.ui.error(result.message);
          return;
        }
      }
      setEnabled(true);
      deps.ui.success(deps.t('browser.enabled'));
    });

  browser
    .command('disable')
    .description('turn off browser escalation (Tier-1 fetch only)')
    .action(() => {
      setEnabled(false);
      deps.ui.success(deps.t('browser.disabled'));
    });

  browser
    .command('status')
    .description('show the local browser status')
    .action(() => {
      const repoRoot = deps.cwd();
      const raw = readRawConfig(repoRoot);
      const section =
        typeof raw['browser'] === 'object' && raw['browser'] !== null
          ? (raw['browser'] as Record<string, unknown>)
          : {};
      const enabled = section['enabled'] === true;
      deps.ui.info(
        deps.t('browser.status', {
          state: browserState(),
          enabled: enabled ? deps.t('browser.on') : deps.t('browser.off'),
        }),
      );
    });

  browser
    .command('remove')
    .description('uninstall Chromium and disable browser escalation')
    .action(() => {
      const removed = removeBrowser();
      setEnabled(false);
      deps.ui.success(removed ? deps.t('browser.removed') : deps.t('browser.remove-none'));
    });
}
