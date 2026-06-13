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
      deps.ui.warn(
        'Honest stub: the CMUX integration activates in milestone OSS-10 — multi-pane sessions ' +
          '(planner / implementer / reviewer / tests / logs) with artifacts kept in .excalibur/runs/.',
      );
      if (isCommandOnPath('cmux', deps.env)) {
        deps.ui.success('CMUX detected on this machine — you are ready for OSS-10.');
      } else {
        deps.ui.info('CMUX is not installed. It is optional: every workflow works without it.');
      }
      deps.ui.info('Until then: excalibur run "<task>" executes the same workflows in one terminal.');
    });
}
