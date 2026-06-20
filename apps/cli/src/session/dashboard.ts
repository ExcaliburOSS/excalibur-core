import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { ExcaliburConfig } from '@excalibur/shared';
import type { CliDeps } from '../deps';
import { createExcaliburServer } from '../lib/serve';

/**
 * The interactive shell's companion **web dashboard** (read-only). Per the
 * onboarding UX, the local dashboard comes up automatically with the m-shell so
 * the user can watch runs/events/insights in a browser without discovering
 * `excalibur serve`. It is the SAME server `serve` exposes (localhost + a
 * per-session token, folding the same `reduceRail` as the TUI), started in the
 * background and torn down when the session ends.
 *
 * Safe + unobtrusive: only on a real interactive TTY; localhost-bound; opt out
 * with `ui.dashboard: false` or `EXCALIBUR_DASHBOARD=off`; if every candidate
 * port is busy it silently skips (never blocks or errors the shell).
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
  const optOut = (deps.env['EXCALIBUR_DASHBOARD'] ?? '').toLowerCase();
  if (optOut === 'off' || optOut === '0' || optOut === 'false') {
    return null;
  }

  const host = '127.0.0.1';
  const token = randomBytes(16).toString('hex');
  for (const port of PORTS) {
    const server: Server = createExcaliburServer({ repoRoot, token });
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
      deps.ui.info(deps.t('dashboard.up', { url }));
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
