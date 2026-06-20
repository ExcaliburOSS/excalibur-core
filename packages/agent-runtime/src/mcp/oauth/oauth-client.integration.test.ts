import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorize } from './oauth-client';
import { startLoopback } from './loopback';

/**
 * REAL end-to-end OAuth integration: a localhost authorization server (a legit
 * test double of an EXTERNAL authz server, like the inline MCP echo server) drives
 * the ACTUAL flow over REAL HTTP — discovery (RFC 9728/8414), DCR (RFC 7591),
 * Authorization-Code+PKCE, the REAL loopback redirect listener, and code exchange.
 * The only stub is `openUrl`, which fetches the authorize URL the way a browser
 * would (the server then 302s to the loopback). No mocks of Excalibur's own code.
 */
describe('OAuth flow over real HTTP (local authz server + real loopback)', () => {
  let server: Server;
  let base: string;
  let tokenBody = '';

  beforeEach(async () => {
    tokenBody = '';
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base);
      const json = (obj: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname === '/.well-known/oauth-protected-resource') {
        json({ authorization_servers: [base] });
      } else if (url.pathname === '/.well-known/oauth-authorization-server') {
        json({
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
        });
      } else if (url.pathname === '/register') {
        json({ client_id: 'local-client' });
      } else if (url.pathname === '/authorize') {
        // Auto-approve: redirect straight back to the loopback with a code.
        const redirect = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        res.writeHead(302, {
          location: `${redirect}?code=LOCALCODE&state=${encodeURIComponent(state)}`,
        });
        res.end();
      } else if (url.pathname === '/token') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          tokenBody = body;
          json({
            access_token: 'LOCAL_AT',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'LOCAL_RT',
          });
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => server.close());

  it('authorizes end-to-end and returns real tokens (DCR + PKCE)', async () => {
    const token = await authorize(`${base}/mcp/`, {
      fetchImpl: globalThis.fetch as typeof fetch,
      loopback: () => startLoopback(),
      // The "browser": fetch the authorize URL; the server 302s to the loopback.
      openUrl: async (authUrl) => {
        await (globalThis.fetch as typeof fetch)(authUrl);
      },
    });
    expect(token.accessToken).toBe('LOCAL_AT');
    expect(token.refreshToken).toBe('LOCAL_RT');
    expect(token.clientId).toBe('local-client');
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    expect(tokenBody).toContain('code=LOCALCODE');
    expect(tokenBody).toContain('code_verifier=');
  });
});
