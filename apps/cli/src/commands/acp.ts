import type { Command } from 'commander';
import { RunController } from '@excalibur/core';
import type { CliDeps } from '../deps';
import { loadConfigContext, loadGatewayContext } from '../lib/context';
import { runAcpServer } from '../lib/acp-server';

/**
 * `excalibur acp` — runs the Agent Client Protocol server over stdio (P0.3c) so
 * an external editor (Zed, JetBrains, Neovim, …) can spawn Excalibur and drive
 * runs via JSON-RPC. stdout carries the protocol — nothing else may print to it,
 * so this action never uses `deps.ui` (which writes stdout); errors go to stderr.
 * Blocks until stdin closes.
 */
export function registerAcpCommand(program: Command, deps: CliDeps): void {
  program
    .command('acp')
    .description('run the Agent Client Protocol server over stdio (for editor integrations)')
    .action(async () => {
      const repoRoot = deps.cwd();
      const controller = new RunController();
      runAcpServer({
        input: process.stdin,
        output: process.stdout,
        defaultCwd: repoRoot,
        startRun: ({ cwd, prompt }) => {
          const { config } = loadConfigContext(cwd);
          const { gateway } = loadGatewayContext(cwd);
          return controller.startRun({ repoRoot: cwd, task: prompt, gateway, config });
        },
      });
      // Keep the process alive until the editor closes stdin.
      await new Promise<void>((resolve) => {
        process.stdin.on('end', resolve);
        process.stdin.on('close', resolve);
      });
    });
}
