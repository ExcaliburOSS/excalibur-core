import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Lazy Chromium lifecycle for the OPT-IN Tier-2 browser (F4), mirroring
 * `searxng-manager.ts` (probe-only vs install). The CLI is a zero-dep single-file
 * bundle: `@playwright/mcp` and the Chromium binary are NEVER bundled and NEVER
 * auto-installed. Chromium is downloaded ONLY when the user runs
 * `excalibur browser enable`, and the browser tier is a graceful no-op (→ Tier-1)
 * whenever it is absent.
 */

export type BrowserState = 'installed' | 'absent' | 'node-missing';

/** The Playwright browsers cache directory (XDG/PLAYWRIGHT_BROWSERS_PATH aware). */
export function playwrightBrowsersPath(): string {
  const override = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (override !== undefined && override.length > 0 && override !== '0') {
    return override;
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  if (platform() === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    return join(local, 'ms-playwright');
  }
  return join(homedir(), '.cache', 'ms-playwright');
}

/** True when `npx` (Node) is on PATH — required to spawn Playwright MCP. */
function hasNpx(): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--version'], {
    stdio: 'ignore',
    timeout: 10_000,
  });
  return probe.status === 0;
}

/** True when a Chromium revision is installed in the Playwright browsers cache. */
export function chromiumInstalled(): boolean {
  const dir = playwrightBrowsersPath();
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((entry) => entry.startsWith('chromium'));
  } catch {
    return false;
  }
}

/** Reports whether the opt-in browser can run: installed | absent | node-missing. */
export function browserState(): BrowserState {
  if (!hasNpx()) return 'node-missing';
  return chromiumInstalled() ? 'installed' : 'absent';
}

export interface BrowserInstallResult {
  ok: boolean;
  message: string;
}

/**
 * Installs the Chromium binary via Playwright (`npx -y playwright install
 * chromium`). HEAVY and runtime-only — invoked ONLY by `excalibur browser
 * enable`, NEVER on import. Returns a structured result rather than throwing.
 */
export function installBrowser(): BrowserInstallResult {
  if (!hasNpx()) {
    return { ok: false, message: 'Node/npx is not available; cannot install the browser.' };
  }
  try {
    execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['-y', 'playwright', 'install', 'chromium'],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: 600_000,
      },
    );
    return chromiumInstalled()
      ? { ok: true, message: 'Chromium installed for the local browser tier.' }
      : { ok: false, message: 'Playwright ran but no Chromium revision was found afterward.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Failed to install Chromium: ${message}` };
  }
}

/** Best-effort removal of the installed Chromium (frees disk). */
export function removeBrowser(): boolean {
  if (!hasNpx()) return false;
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['-y', 'playwright', 'uninstall', 'chromium'],
    { stdio: 'ignore', timeout: 120_000 },
  );
  return result.status === 0;
}
