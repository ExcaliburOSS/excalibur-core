import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorize,
  buildAuthorizeUrl,
  generatePkce,
  parseWwwAuthenticate,
  type LoopbackRedirect,
  type OAuthFetch,
} from './oauth-client';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('PKCE + helpers', () => {
  it('generates an S256 challenge from the verifier', () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(base64url(createHash('sha256').update(verifier).digest()));
  });

  it('parses the resource_metadata from a WWW-Authenticate header', () => {
    expect(
      parseWwwAuthenticate(
        'Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource"',
      ),
    ).toBe('https://x.test/.well-known/oauth-protected-resource');
    expect(parseWwwAuthenticate(null)).toBeNull();
  });

  it('builds an authorize URL with PKCE + state', () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: 'https://as.test/authorize',
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1:1/cb',
        state: 'st',
        challenge: 'ch',
        scope: 'read',
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toBe('read');
  });
});

describe('authorize (full flow, offline)', () => {
  it('discovers → registers (DCR) → exchanges the code with PKCE', async () => {
    let tokenBody = '';
    const fetchImpl: OAuthFetch = async (url, init) => {
      const u = url.toString();
      if (u.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ authorization_servers: ['https://as.test'] }));
      }
      if (u === 'https://as.test/.well-known/oauth-authorization-server') {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://as.test/authorize',
            token_endpoint: 'https://as.test/token',
            registration_endpoint: 'https://as.test/register',
          }),
        );
      }
      if (u === 'https://as.test/register') {
        return new Response(JSON.stringify({ client_id: 'dyn-client' }));
      }
      if (u === 'https://as.test/token') {
        tokenBody = String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            access_token: 'AT',
            refresh_token: 'RT',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'read',
          }),
        );
      }
      throw new Error(`unexpected ${u}`);
    };

    // Fake loopback: capture the state the client put in the authorize URL and
    // echo it back with a code (what the real authz server's redirect would do).
    let capturedState = '';
    const loopback = async (): Promise<LoopbackRedirect> => ({
      redirectUri: 'http://127.0.0.1:12345/callback',
      waitForCode: async () => ({ code: 'THE_CODE', state: capturedState }),
      close: () => undefined,
    });
    const openUrl = (authUrl: string): void => {
      capturedState = new URL(authUrl).searchParams.get('state') ?? '';
    };

    const token = await authorize('https://api.example.com/mcp/', { fetchImpl, loopback, openUrl });
    expect(token.accessToken).toBe('AT');
    expect(token.refreshToken).toBe('RT');
    expect(token.clientId).toBe('dyn-client');
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    // The token request carried the PKCE verifier + the auth-code grant.
    expect(tokenBody).toContain('grant_type=authorization_code');
    expect(tokenBody).toContain('code_verifier=');
    expect(tokenBody).toContain('code=THE_CODE');
  });

  it('aborts on a state mismatch (CSRF guard)', async () => {
    const fetchImpl: OAuthFetch = async (url) => {
      const u = url.toString();
      if (u.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ authorization_servers: ['https://as.test'] }));
      }
      if (u === 'https://as.test/.well-known/oauth-authorization-server') {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://as.test/authorize',
            token_endpoint: 'https://as.test/token',
          }),
        );
      }
      throw new Error(`unexpected ${u}`);
    };
    const loopback = async (): Promise<LoopbackRedirect> => ({
      redirectUri: 'http://127.0.0.1:1/cb',
      waitForCode: async () => ({ code: 'c', state: 'WRONG' }),
      close: () => undefined,
    });
    await expect(
      authorize('https://api.example.com/mcp/', {
        fetchImpl,
        loopback,
        openUrl: () => undefined,
        clientId: 'preset',
      }),
    ).rejects.toThrow(/state mismatch/i);
  });
});
