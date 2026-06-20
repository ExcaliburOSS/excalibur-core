import { createHash, randomBytes } from 'node:crypto';
import type { StoredToken } from './token-store';

/**
 * OAuth 2.0 client for remote MCP servers (F6): Protected-Resource discovery
 * (RFC 9728) → Authorization-Server metadata (RFC 8414) → Dynamic Client
 * Registration (RFC 7591) → Authorization Code + PKCE (S256). No deps — `fetch`,
 * the loopback redirect listener, and the browser-open are all INJECTED, so the
 * whole protocol is unit-tested offline with a fake auth server, and a REAL local
 * server can drive it end-to-end. Tokens are returned for the caller to persist
 * via {@link McpTokenStore}.
 */

export type OAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class OAuthError extends Error {}

export interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generates a PKCE verifier + S256 challenge (RFC 7636). */
export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Extracts the `resource_metadata` URL from a `WWW-Authenticate: Bearer …` header (RFC 9728). */
export function parseWwwAuthenticate(header: string | null): string | null {
  if (header === null) return null;
  const match = /resource_metadata="?([^",\s]+)"?/i.exec(header);
  return match?.[1] ?? null;
}

/** RFC 9728: the protected-resource metadata URL for a server origin. */
export function protectedResourceUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${u.origin}/.well-known/oauth-protected-resource`;
}

async function getJson(fetchImpl: OAuthFetch, url: string): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new OAuthError(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** RFC 9728 → the first authorization server issuer for a protected resource. */
export async function discoverIssuer(
  fetchImpl: OAuthFetch,
  resourceMetadataUrl: string,
): Promise<string | null> {
  try {
    const doc = await getJson(fetchImpl, resourceMetadataUrl);
    const servers = doc['authorization_servers'];
    if (Array.isArray(servers) && typeof servers[0] === 'string') return servers[0];
  } catch {
    /* fall through — caller treats the server origin as the issuer */
  }
  return null;
}

/** RFC 8414 → the authorization server's endpoints. */
export async function discoverAuthServer(
  fetchImpl: OAuthFetch,
  issuer: string,
): Promise<AuthServerMetadata> {
  const base = issuer.replace(/\/$/, '');
  const doc = await getJson(fetchImpl, `${base}/.well-known/oauth-authorization-server`);
  const authorization = doc['authorization_endpoint'];
  const token = doc['token_endpoint'];
  if (typeof authorization !== 'string' || typeof token !== 'string') {
    throw new OAuthError('authorization server metadata missing authorization/token endpoint');
  }
  return {
    authorization_endpoint: authorization,
    token_endpoint: token,
    ...(typeof doc['registration_endpoint'] === 'string'
      ? { registration_endpoint: doc['registration_endpoint'] }
      : {}),
    ...(Array.isArray(doc['scopes_supported'])
      ? { scopes_supported: doc['scopes_supported'] as string[] }
      : {}),
  };
}

/** RFC 7591 Dynamic Client Registration → a client_id (+ optional secret). */
export async function registerClient(
  fetchImpl: OAuthFetch,
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Excalibur',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) throw new OAuthError(`dynamic client registration → HTTP ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  if (typeof doc['client_id'] !== 'string') {
    throw new OAuthError('registration response missing client_id');
  }
  return {
    clientId: doc['client_id'],
    ...(typeof doc['client_secret'] === 'string' ? { clientSecret: doc['client_secret'] } : {}),
  };
}

/** Builds the Authorization-Code+PKCE authorize URL. */
export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string;
  resource?: string;
}): string {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (opts.scope !== undefined && opts.scope.length > 0) url.searchParams.set('scope', opts.scope);
  if (opts.resource !== undefined) url.searchParams.set('resource', opts.resource);
  return url.toString();
}

function expiresAt(doc: Record<string, unknown>): number | undefined {
  return typeof doc['expires_in'] === 'number' ? Date.now() + doc['expires_in'] * 1000 : undefined;
}

/** Exchanges an authorization code for tokens (with the PKCE verifier). */
export async function exchangeCode(
  fetchImpl: OAuthFetch,
  opts: {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    verifier: string;
  },
): Promise<StoredToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
    ...(opts.clientSecret !== undefined ? { client_secret: opts.clientSecret } : {}),
  });
  const res = await fetchImpl(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) throw new OAuthError(`token exchange → HTTP ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;
  if (typeof doc['access_token'] !== 'string') {
    throw new OAuthError('token response missing access_token');
  }
  return {
    accessToken: doc['access_token'],
    ...(typeof doc['token_type'] === 'string' ? { tokenType: doc['token_type'] } : {}),
    ...(typeof doc['refresh_token'] === 'string' ? { refreshToken: doc['refresh_token'] } : {}),
    ...(expiresAt(doc) !== undefined ? { expiresAt: expiresAt(doc) } : {}),
    ...(typeof doc['scope'] === 'string' ? { scope: doc['scope'] } : {}),
    clientId: opts.clientId,
    ...(opts.clientSecret !== undefined ? { clientSecret: opts.clientSecret } : {}),
    tokenUrl: opts.tokenEndpoint,
  };
}

/** Refreshes an access token using a stored refresh token (RFC 6749 §6). */
export async function refreshToken(
  fetchImpl: OAuthFetch,
  token: StoredToken,
): Promise<StoredToken | null> {
  if (
    token.refreshToken === undefined ||
    token.tokenUrl === undefined ||
    token.clientId === undefined
  ) {
    return null;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
    client_id: token.clientId,
    ...(token.clientSecret !== undefined ? { client_secret: token.clientSecret } : {}),
  });
  const res = await fetchImpl(token.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const doc = (await res.json()) as Record<string, unknown>;
  if (typeof doc['access_token'] !== 'string') return null;
  return {
    ...token,
    accessToken: doc['access_token'],
    ...(typeof doc['refresh_token'] === 'string' ? { refreshToken: doc['refresh_token'] } : {}),
    ...(expiresAt(doc) !== undefined ? { expiresAt: expiresAt(doc) } : {}),
  };
}

/** A loopback redirect listener (injected so tests/CLI provide the real one). */
export interface LoopbackRedirect {
  redirectUri: string;
  waitForCode: () => Promise<{ code: string; state: string }>;
  close: () => void;
}

export interface AuthorizeDeps {
  fetchImpl: OAuthFetch;
  /** Starts a loopback HTTP listener on 127.0.0.1 and returns its redirect URI. */
  loopback: () => Promise<LoopbackRedirect>;
  /** Opens the authorization URL (browser). */
  openUrl: (url: string) => void | Promise<void>;
  scope?: string;
  /** Pre-configured client_id (skips DCR when the server has no registration endpoint). */
  clientId?: string;
}

/**
 * Full authorization flow for a remote MCP `serverUrl`: discover → (DCR) → open
 * the browser → catch the loopback redirect → exchange the code → return tokens.
 * `wwwAuthenticate` (from a prior 401) is used to locate the resource metadata.
 */
export async function authorize(
  serverUrl: string,
  deps: AuthorizeDeps,
  wwwAuthenticate?: string | null,
): Promise<StoredToken> {
  const { fetchImpl } = deps;
  const resourceMetadataUrl =
    parseWwwAuthenticate(wwwAuthenticate ?? null) ?? protectedResourceUrl(serverUrl);
  const issuer =
    (await discoverIssuer(fetchImpl, resourceMetadataUrl)) ?? new URL(serverUrl).origin;
  const meta = await discoverAuthServer(fetchImpl, issuer);

  const loopback = await deps.loopback();
  try {
    let clientId = deps.clientId;
    let clientSecret: string | undefined;
    if (clientId === undefined) {
      if (meta.registration_endpoint === undefined) {
        throw new OAuthError(
          'server has no dynamic registration endpoint and no client_id was configured',
        );
      }
      const reg = await registerClient(fetchImpl, meta.registration_endpoint, loopback.redirectUri);
      clientId = reg.clientId;
      clientSecret = reg.clientSecret;
    }
    const pkce = generatePkce();
    const state = base64url(randomBytes(16));
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: meta.authorization_endpoint,
      clientId,
      redirectUri: loopback.redirectUri,
      state,
      challenge: pkce.challenge,
      ...(deps.scope !== undefined ? { scope: deps.scope } : {}),
      resource: serverUrl,
    });
    await deps.openUrl(authorizeUrl);
    const cb = await loopback.waitForCode();
    if (cb.state !== state) {
      throw new OAuthError('OAuth state mismatch (possible CSRF) — aborting');
    }
    return await exchangeCode(fetchImpl, {
      tokenEndpoint: meta.token_endpoint,
      code: cb.code,
      redirectUri: loopback.redirectUri,
      clientId,
      ...(clientSecret !== undefined ? { clientSecret } : {}),
      verifier: pkce.verifier,
    });
  } finally {
    loopback.close();
  }
}
