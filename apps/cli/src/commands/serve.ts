import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { RunController } from '@excalibur/core';
import { executionStyleSchema, isAutonomyLevel, type ExecutionStyle } from '@excalibur/shared';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { loadConfigContext, loadGatewayContext } from '../lib/context';
import { createExcaliburServer, type ServeWriteHandler } from '../lib/serve';

/** Builds the control-plane write handler: start/cancel/approve runs via a RunController. */
function buildWriteHandler(repoRoot: string): ServeWriteHandler {
  const { config } = loadConfigContext(repoRoot);
  const { gateway, providerName, configured } = loadGatewayContext(repoRoot);
  const controller = new RunController();
  return {
    startRun: async (input) => {
      // Refuse rather than silently run the mock test double (mirrors the `run`
      // command's requireConfiguredModel guard); handleWrite turns this into 400.
      if (!configured) {
        throw new Error(
          'no model provider configured — add .excalibur/models/providers.yaml (e.g. run `excalibur models`).',
        );
      }
      const style = executionStyleSchema.safeParse(input.executionStyle);
      const handle = await controller.startRun({
        repoRoot,
        task: input.task,
        gateway,
        config,
        // Resolved provider (providers.yaml default) so the run uses the real
        // configured model rather than falling back to the `mock` provider.
        model: providerName,
        ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
        ...(input.autonomyLevel !== undefined && isAutonomyLevel(input.autonomyLevel)
          ? { autonomyLevel: input.autonomyLevel }
          : {}),
        ...(style.success ? { executionStyle: style.data as ExecutionStyle } : {}),
        ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
      });
      return { runId: handle.runId };
    },
    cancel: (runId) => controller.cancel(runId),
    approve: (runId, decision) => {
      const handle = controller.get(runId);
      if (handle === undefined) {
        return false;
      }
      handle.approve(decision);
      return true;
    },
  };
}

/**
 * `excalibur serve [--port N] [--host H]` — a local, read-only HTTP + SSE server
 * over the run event stream (plan P1.12). It powers the OSS web dashboard and a
 * remote viewer, both folding the SAME `reduceRail` → byte-identical to the TUI.
 * Token-gated + localhost by default. Blocks until Ctrl-C.
 */
export function registerServeCommand(program: Command, deps: CliDeps): void {
  program
    .command('serve')
    .description(
      'serve runs/events/insights over local HTTP + SSE (read-only; powers the web dashboard)',
    )
    .option('--port <n>', 'port to listen on', '4319')
    .option('--host <host>', 'host to bind (localhost by default for safety)', '127.0.0.1')
    .option('--token <token>', 'shared secret (default: a random per-process token)')
    .option(
      '--write',
      'enable the control-plane write surface (POST start/cancel/approve runs) — runs EXECUTE',
    )
    .option('--share', 'also mint a READ-ONLY share token + print a shareable view URL')
    .action(
      (options: {
        port?: string;
        host?: string;
        token?: string;
        write?: boolean;
        share?: boolean;
      }) => {
        const port = Number.parseInt(options.port ?? '4319', 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new CliUsageError(`--port must be 1..65535 (got "${options.port}").`);
        }
        const host = options.host ?? '127.0.0.1';
        const token = options.token ?? randomBytes(16).toString('hex');
        const repoRoot = deps.cwd();

        const write = options.write === true ? buildWriteHandler(repoRoot) : undefined;
        const shareToken = options.share === true ? randomBytes(16).toString('hex') : undefined;
        const server = createExcaliburServer({
          repoRoot,
          token,
          ...(write !== undefined ? { write } : {}),
          ...(shareToken !== undefined ? { shareToken } : {}),
        });
        server.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            deps.ui.error(deps.t('serve.port-in-use', { port }));
          } else {
            deps.ui.error(error.message);
          }
          process.exitCode = 1;
        });
        server.listen(port, host, () => {
          const base = `http://${host}:${port}`;
          deps.ui.success(deps.t('serve.listening', { base }));
          deps.ui.write(deps.t('serve.token', { token }));
          deps.ui.write(deps.t('serve.example', { base, token }));
          if (write !== undefined) {
            deps.ui.warn(
              'Write surface ENABLED: POST /api/runs (start), /api/runs/:id/cancel, /api/runs/:id/approve (these EXECUTE runs) + /api/work-items/:key/move (drag-to-change-lane). Keep the token secret + the bind localhost.',
            );
          }
          if (shareToken !== undefined) {
            deps.ui.write(`Read-only share link: ${base}/?token=${shareToken}`);
          }
          deps.ui.write(deps.t('serve.stop'));
        });

        const shutdown = (): void => {
          server.close(() => process.exit(0));
          // If connections linger (an open SSE stream), force-exit shortly after.
          setTimeout(() => process.exit(0), 500).unref?.();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      },
    );
}
