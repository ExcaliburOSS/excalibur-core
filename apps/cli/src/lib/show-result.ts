import { spawn } from 'node:child_process';
import { previewProject } from '@excalibur/agent-runtime';
import type { CliDeps } from '../deps';
import { accent } from './accent';

/**
 * "Show the result" — the deterministic finish step every build/mission ends with: if the
 * project is runnable, SERVE it locally and put the URL in front of the user (and open their
 * browser). The founder's standing rule: a job is not done until the user can SEE what was
 * made — a web app on a local server, and (future) a mobile app in a simulator. Non-web
 * projects with nothing to serve are a silent no-op ("si es posible").
 *
 * Deterministic on purpose: it does NOT rely on the model remembering to call the `preview`
 * tool (which it kept forgetting). Reuses the SAME preview engine as that tool. Best-effort —
 * a preview failure (busy ports, no URL) degrades to a quiet note; it never throws into the
 * turn or blocks it.
 */
export async function showResult(deps: CliDeps, repoRoot: string): Promise<void> {
  let outcome;
  try {
    outcome = await previewProject(repoRoot, { timeoutMs: 25_000 });
  } catch {
    return; // showing the result is additive — a preview fault never breaks the turn
  }
  if (!outcome.previewable) {
    return; // nothing runnable to show (a library, a CLI, docs) — stay silent
  }
  deps.ui.write();
  if (outcome.url !== null) {
    deps.ui.write(accent(deps.t('show-result.live', { url: outcome.url })));
    openInBrowser(outcome.url);
    return;
  }
  // Started but no URL surfaced in time (e.g. a first `dev` build still compiling, or every
  // candidate port busy). Tell the user it is coming up rather than swallow it.
  deps.ui.info(deps.t('show-result.no-url', { label: outcome.label }));
}

/**
 * Open a URL in the user's default browser — best-effort, detached, silent on failure. The
 * point of "show me the result" is that the running app appears in front of the user; on a
 * local dev machine that means the browser. Never blocks and never throws.
 */
function openInBrowser(url: string): void {
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening the browser is a courtesy — the printed URL is the real deliverable */
  }
}
