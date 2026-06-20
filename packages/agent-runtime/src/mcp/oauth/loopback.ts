import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoopbackRedirect } from './oauth-client';

/**
 * The REAL loopback redirect listener + browser opener for the OAuth flow (F6).
 * Kept separate from oauth-client.ts (which is pure + injectable) so the protocol
 * is unit-tested offline and only this thin I/O glue touches the network/OS.
 *
 * Security: binds to 127.0.0.1 on an ephemeral port (the redirect URI the authz
 * server posts the code back to) — never a public interface.
 */
export async function startLoopback(callbackPath = '/callback'): Promise<LoopbackRedirect> {
  let resolveCode: (v: { code: string; state: string }) => void = () => undefined;
  let rejectCode: (e: Error) => void = () => undefined;
  const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== callbackPath) {
      res.writeHead(404);
      res.end();
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>Excalibur</h2><p>Authorization complete — you can close this tab and return to the terminal.</p></body></html>',
    );
    if (error !== null) {
      rejectCode(new Error(`authorization error: ${error}`));
    } else if (code !== null && state !== null) {
      resolveCode({ code, state });
    } else {
      rejectCode(new Error('authorization redirect missing code/state'));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    redirectUri: `http://127.0.0.1:${port}${callbackPath}`,
    waitForCode: () => codePromise,
    close: () => server.close(),
  };
}

/** Best-effort opens `url` in the OS browser (no-op on failure; the URL is also printed). */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless / no browser — the caller prints the URL for manual open */
  }
}
