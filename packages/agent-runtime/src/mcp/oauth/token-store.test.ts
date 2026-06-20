import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpTokenStore } from './token-store';

describe('McpTokenStore', () => {
  let dir: string;
  let store: McpTokenStore;
  const url = 'https://api.example.com/mcp/';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exc-mcp-tok-'));
    store = new McpTokenStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('stores, reads and deletes a token (0600 file mode)', () => {
    expect(store.get(url)).toBeNull();
    store.set(url, { accessToken: 'AT', refreshToken: 'RT' });
    expect(store.get(url)?.accessToken).toBe('AT');
    const file = join(dir, `${createHash('sha256').update(url).digest('hex')}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.delete(url)).toBe(true);
    expect(store.get(url)).toBeNull();
  });

  it('validAccessToken returns null for an expired token', () => {
    store.set(url, { accessToken: 'AT', expiresAt: Date.now() - 1000 });
    expect(store.validAccessToken(url)).toBeNull();
    store.set(url, { accessToken: 'AT2', expiresAt: Date.now() + 3_600_000 });
    expect(store.validAccessToken(url)).toBe('AT2');
  });

  it('keys by URL (different servers do not collide)', () => {
    store.set('https://a.test/', { accessToken: 'A' });
    store.set('https://b.test/', { accessToken: 'B' });
    expect(store.get('https://a.test/')?.accessToken).toBe('A');
    expect(store.get('https://b.test/')?.accessToken).toBe('B');
  });
});
