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
          const { gateway, providerName, configured } = loadGatewayContext(cwd);
          // The mock is a test double, NEVER a silent runtime fallback: refuse
          // (the editor surfaces this as a JSON-RPC error) rather than quietly
          // running the agent against the mock when no provider is configured.
          if (!configured) {
            throw new Error(
              'No model provider configured — add .excalibur/models/providers.yaml (e.g. run `excalibur models`) before using Excalibur in your editor.',
            );
          }
          // Pass the RESOLVED provider (providers.yaml default, e.g. `groq`) so the
          // run uses the configured real model — without it the run falls back to
          // the `mock` provider and fails when only real providers are configured.
          return controller.startRun({
            repoRoot: cwd,
            task: prompt,
            gateway,
            config,
            model: providerName,
          });
        },
      });
      // Keep the process alive until the editor closes stdin.
      await new Promise<void>((resolve) => {
        process.stdin.on('end', resolve);
        process.stdin.on('close', resolve);
      });
    });
}
