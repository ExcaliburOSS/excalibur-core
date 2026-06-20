import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Persistent OAuth token store for remote MCP servers (F6). Tokens live OUTSIDE
 * the repo — under `~/.config/excalibur/mcp/tokens/` (XDG-aware), keyed by
 * `sha256(serverUrl)`, with strict perms (dir 0700, file 0600) like the
 * enterprise credential store. NEVER written to `.excalibur/` (which is
 * committable). Injectable `baseDir` for tests.
 */

export interface StoredToken {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  /** Absolute expiry, epoch ms. */
  expiresAt?: number;
  scope?: string;
  /** DCR client identity (so a refresh can re-auth without re-registering). */
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function defaultDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const root = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(root, 'excalibur', 'mcp', 'tokens');
}

export class McpTokenStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? defaultDir();
  }

  private pathFor(serverUrl: string): string {
    return join(this.baseDir, `${createHash('sha256').update(serverUrl).digest('hex')}.json`);
  }

  get(serverUrl: string): StoredToken | null {
    const path = this.pathFor(serverUrl);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as StoredToken;
    } catch {
      return null;
    }
  }

  set(serverUrl: string, token: StoredToken): void {
    mkdirSync(this.baseDir, { recursive: true, mode: DIR_MODE });
    writeFileSync(this.pathFor(serverUrl), JSON.stringify(token), { mode: FILE_MODE });
  }

  delete(serverUrl: string): boolean {
    const path = this.pathFor(serverUrl);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  /** The current access token if present AND not expired (60s skew), else null. */
  validAccessToken(serverUrl: string, now: number = Date.now()): string | null {
    const token = this.get(serverUrl);
    if (token === null) return null;
    if (token.expiresAt !== undefined && token.expiresAt <= now + 60_000) return null;
    return token.accessToken;
  }
}
