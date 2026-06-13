import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import { buildRepoContextSources } from './repo-context';

describe('buildRepoContextSources', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });
  afterEach(() => removeDir(repoRoot));

  function write(relPath: string, content: string): void {
    const filePath = join(repoRoot, ...relPath.split('/'));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }

  it('formats each hit as a labeled [repo-context: …] source with line numbers', async () => {
    write(
      'src/auth/session.ts',
      [
        'export interface Session {',
        '  token: string;',
        '}',
        '',
        'export function createSession(token: string): Session {',
        '  return { token };',
        '}',
      ].join('\n'),
    );

    const sources = await buildRepoContextSources({
      repoRoot,
      query: 'createSession session token',
    });

    expect(sources.length).toBeGreaterThan(0);
    const sessionSource = sources.find((s) => s.path.includes('src/auth/session.ts'));
    expect(sessionSource).toBeDefined();
    expect(sessionSource?.content).toContain('[repo-context: src/auth/session.ts — matched:');
    expect(sessionSource?.content).toMatch(/lines? \d+/);
    expect(sessionSource?.content).toContain('createSession');
  });

  it('returns [] when nothing matches', async () => {
    write('src/foo.ts', 'export const foo = 1;\n');
    const sources = await buildRepoContextSources({
      repoRoot,
      query: 'nonexistent-keyword-xyzzy',
    });
    expect(sources).toEqual([]);
  });

  it('never surfaces .env / secret files in retrieved context', async () => {
    write('.env', 'API_KEY=AKIAIOSFODNN7EXAMPLE\n');
    write('src/secrets/keys.ts', 'export const KEY = "session-token-secret";\n');
    write('src/auth/login.ts', 'export function login() { return "session"; }\n');

    const sources = await buildRepoContextSources({
      repoRoot,
      query: 'session token key',
    });
    const allContent = sources.map((s) => s.content).join('\n');
    expect(allContent).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(allContent).not.toContain('session-token-secret');
    expect(sources.some((s) => s.path.includes('secrets/'))).toBe(false);
    expect(sources.some((s) => s.path.includes('.env'))).toBe(false);
  });

  it('redacts secrets embedded in ordinary code before injecting them (defense in depth)', async () => {
    // A secret living in a NORMAL file (not a secret path) is still retrieved,
    // so it must be masked at the source, not only by the downstream render().
    const fakeKey = 'sk-' + 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90';
    write(
      'src/payment-config.ts',
      [
        'export const PAYMENT_CONFIG = {',
        `  apiKey: "${fakeKey}",`,
        '  endpoint: "https://api.payments.example.com",',
        '};',
      ].join('\n'),
    );

    const sources = await buildRepoContextSources({
      repoRoot,
      query: 'payment config apiKey endpoint',
    });
    const source = sources.find((s) => s.path.includes('src/payment-config.ts'));
    expect(source).toBeDefined();
    expect(source?.content).not.toContain(fakeKey);
    expect(source?.content).toContain('[REDACTED]');
  });

  it('passes anchorPath through to retrieval (neighbor boost)', async () => {
    write('src/auth/login.ts', "import { createSession } from './session';\nexport function login() {}\n");
    write('src/auth/session.ts', 'export function createSession() { return {}; }\n');
    write('src/billing/invoice.ts', 'export function createInvoice() { return {}; }\n');

    const sources = await buildRepoContextSources({
      repoRoot,
      query: 'create session invoice',
      anchorPath: 'src/auth/login.ts',
    });
    const paths = sources.map((s) => s.path);
    // The anchor file itself is excluded; the same-dir neighbor is present.
    expect(paths.some((p) => p.includes('src/auth/login.ts'))).toBe(false);
    expect(paths.some((p) => p.includes('src/auth/session.ts'))).toBe(true);
  });
});
