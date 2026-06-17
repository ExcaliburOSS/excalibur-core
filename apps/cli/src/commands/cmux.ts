import { isCommandOnPath } from '@excalibur/agent-runtime';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';

/**
 * `excalibur cmux` — honest OSS-10 stub. CMUX is an optional multiplexer
 * interface, never a hard dependency (OSS spec §16).
 */
export function registerCmuxCommand(program: Command, deps: CliDeps): void {
  program
    .command('cmux')
    .description('run Excalibur workflows in CMUX panes (arrives in OSS-10)')
    .allowExcessArguments(true)
    .action(() => {
      deps.ui.warn(deps.t('cmux.stub'));
      if (isCommandOnPath('cmux', deps.env)) {
        deps.ui.success(deps.t('cmux.detected'));
      } else {
        deps.ui.info(deps.t('cmux.not-installed'));
      }
      deps.ui.info(deps.t('cmux.fallback'));
    });
}
