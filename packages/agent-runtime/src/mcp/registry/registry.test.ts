import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadRegistry, lookupServer, searchRegistry, verifySignedSnapshot } from './registry';

describe('bundled signed registry', () => {
  it('loads + verifies the bundled snapshot (signature + pinned fingerprint)', () => {
    const reg = loadRegistry();
    expect(reg.ok).toBe(true);
    expect(reg.reason).toBe('');
    expect(reg.servers.length).toBeGreaterThan(0);
  });

  it('looks up and searches verified servers (ranked by trust score)', () => {
    expect(lookupServer('filesystem')?.transport).toBe('stdio');
    expect(lookupServer('github')?.transport).toBe('http');
    expect(lookupServer('does-not-exist')).toBeUndefined();
    const browser = searchRegistry('browser');
    expect(browser.some((s) => s.name === 'playwright')).toBe(true);
    const all = searchRegistry('');
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i - 1]!.trustScore).toBeGreaterThanOrEqual(all[i]!.trustScore);
    }
  });
});

describe('verifySignedSnapshot (Ed25519)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const snapshot = { version: 1, servers: [{ name: 'x' }] };
  const signature = sign(null, Buffer.from(JSON.stringify(snapshot), 'utf8'), privateKey).toString(
    'base64',
  );

  it('accepts a valid signature', () => {
    expect(verifySignedSnapshot(snapshot, signature, pem)).toBe(true);
  });

  it('rejects a tampered snapshot', () => {
    expect(verifySignedSnapshot({ ...snapshot, version: 2 }, signature, pem)).toBe(false);
  });

  it('rejects a different (swapped) public key', () => {
    const other = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    expect(verifySignedSnapshot(snapshot, signature, other)).toBe(false);
  });
});
