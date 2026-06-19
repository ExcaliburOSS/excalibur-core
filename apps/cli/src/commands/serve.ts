import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { createExcaliburServer } from '../lib/serve';

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
    .action((options: { port?: string; host?: string; token?: string }) => {
      const port = Number.parseInt(options.port ?? '4319', 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new CliUsageError(`--port must be 1..65535 (got "${options.port}").`);
      }
      const host = options.host ?? '127.0.0.1';
      const token = options.token ?? randomBytes(16).toString('hex');
      const repoRoot = deps.cwd();

      const server = createExcaliburServer({ repoRoot, token });
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
        deps.ui.write(deps.t('serve.stop'));
      });

      const shutdown = (): void => {
        server.close(() => process.exit(0));
        // If connections linger (an open SSE stream), force-exit shortly after.
        setTimeout(() => process.exit(0), 500).unref?.();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
}
