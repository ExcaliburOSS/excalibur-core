import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { ExcaliburConfig } from '@excalibur/shared';
import type { CliDeps } from '../deps';
import { accent, accentBright } from '../lib/accent';
import { buildWriteHandler } from '../commands/serve';
import { createExcaliburServer } from '../lib/serve';

/**
 * The interactive shell's companion **web dashboard** (interactive by default).
 * Per the onboarding UX, the local work-item board comes up automatically with the
 * m-shell so the user can manage work items + watch runs in a browser without
 * discovering `excalibur serve`. It is the SAME server `serve` exposes (localhost +
 * a per-session token, folding the same `reduceRail` as the TUI), started in the
 * background and torn down when the session ends — and it ships the SAME write
 * surface as `serve --write` so you can create/edit/move work items and start runs
 * right there. Safe by construction: localhost-bound + a random per-session token,
 * with the run safety floor (blocked paths, approvals) still in force.
 *
 * Opt out with `ui.dashboard: false` or `EXCALIBUR_DASHBOARD=off`; force read-only
 * with `EXCALIBUR_DASHBOARD=read-only`; only on a real interactive TTY; if every
 * candidate port is busy it silently skips (never blocks or errors the shell).
 */
export interface DashboardHandle {
  url: string;
  stop: () => void;
}

const PORTS = [4319, 4320, 4321, 4322];

export async function startSessionDashboard(
  deps: CliDeps,
  repoRoot: string,
  config: ExcaliburConfig,
): Promise<DashboardHandle | null> {
  if (!deps.ui.isInteractive() || !deps.ui.isOutputTty()) {
    return null;
  }
  if (config.ui?.dashboard === false) {
    return null;
  }
  const mode = (deps.env['EXCALIBUR_DASHBOARD'] ?? '').toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') {
    return null;
  }

  // Interactive by default (create/edit/move work items, start runs). `read-only`
  // opts down. Building the handler loads config/gateway but never throws on an
  // unconfigured repo (model-needing actions just 400) — guard anyway so a fault
  // degrades to read-only instead of dropping the dashboard.
  const readOnly = mode === 'read-only' || mode === 'readonly';
  let write: ReturnType<typeof buildWriteHandler> | undefined;
  if (!readOnly) {
    try {
      write = buildWriteHandler(repoRoot);
    } catch {
      write = undefined;
    }
  }

  const host = '127.0.0.1';
  const token = randomBytes(16).toString('hex');
  for (const port of PORTS) {
    const server: Server = createExcaliburServer({
      repoRoot,
      token,
      ...(write !== undefined ? { write } : {}),
    });
    const listening = await new Promise<boolean>((resolve) => {
      const onError = (): void => {
        server.removeListener('listening', onListening);
        resolve(false); // port busy (or other) → try the next candidate
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    if (listening) {
      server.unref?.(); // don't keep the process alive for the dashboard alone
      const url = `http://${host}:${port}/?token=${token}`;
      // Accent-branded banner, identical to `excalibur serve` — printed as
      // scrollback ABOVE the input box (the box's rules wrap only the live input).
      deps.ui.write(`${accentBright('◆ ' + deps.t('serve.dashboard'))}  ${accent(url)}`);
      return {
        url,
        stop: (): void => {
          try {
            server.close();
          } catch {
            /* already closing/closed */
          }
        },
      };
    }
  }
  return null; // all candidate ports busy — skip silently
}
