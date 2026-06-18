import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { LspClient } from './lsp-client';
import { FAKE_LSP_SERVER } from './__fixtures__/fake-lsp-server';

/**
 * Exercises the client against a configurable fake LSP server (real
 * `Content-Length` byte framing): handshake, server-request answering,
 * publishDiagnostics handling, the version/settle wait, and teardown.
 */
async function startClient(mode: string): Promise<LspClient> {
  const rootUri = pathToFileURL(process.cwd()).href;
  return LspClient.start({
    command: process.execPath,
    args: ['-e', FAKE_LSP_SERVER],
    cwd: process.cwd(),
    rootUri,
    rootPath: process.cwd(),
    initializeTimeoutMs: 4000,
    requestTimeoutMs: 4000,
    env: { ...process.env, FAKE_MODE: mode },
  });
}

const URI = 'file:///tmp/a.ts';
const WAIT = { waitMs: 2000, settleMs: 200 };

describe('LspClient against a fake server', () => {
  it('handshakes, then reports a clean file as [] and an errored change as one diagnostic', async () => {
    const client = await startClient('basic');
    try {
      const v1 = client.didOpen(URI, 'typescript', 'const x = 1;');
      expect(await client.diagnosticsFor(URI, v1, WAIT)).toEqual([]);

      const v2 = client.didChange(URI, '__ERR__ const x: number = "s";');
      const diags = await client.diagnosticsFor(URI, v2, WAIT);
      expect(diags).toHaveLength(1);
      expect(diags[0]?.severity).toBe(1);
      expect(diags[0]?.message).toBe('Type error');
    } finally {
      client.close();
    }
  });

  it('answers the server workspace/configuration request (else diagnostics never flow)', async () => {
    const client = await startClient('config-gate');
    try {
      const v1 = client.didOpen(URI, 'typescript', '__ERR__ bad');
      // The fake only publishes AFTER we answer its configuration request.
      const diags = await client.diagnosticsFor(URI, v1, WAIT);
      expect(diags).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  it('settles for the semantic wave (empty syntactic pass, then errors)', async () => {
    const client = await startClient('two-wave');
    try {
      const v = client.didOpen(URI, 'typescript', '__ERR__ bad');
      const diags = await client.diagnosticsFor(URI, v, { waitMs: 2000, settleMs: 200 });
      expect(diags).toHaveLength(1); // the LATER semantic wave wins
    } finally {
      client.close();
    }
  });

  it('ignores a stale-version publish and takes the fresh one', async () => {
    const client = await startClient('stale-then-fresh');
    try {
      const v = client.didOpen(URI, 'typescript', '__ERR__ bad');
      const diags = await client.diagnosticsFor(URI, v, { waitMs: 2000, settleMs: 200 });
      expect(diags).toHaveLength(1); // the version-1 empty wave is ignored
    } finally {
      client.close();
    }
  });

  it('returns [] without hanging when the server never publishes', async () => {
    const client = await startClient('never-publish');
    try {
      const v = client.didOpen(URI, 'typescript', '__ERR__ bad');
      const started = Date.now();
      const diags = await client.diagnosticsFor(URI, v, { waitMs: 300, settleMs: 100 });
      expect(diags).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      client.close();
    }
  });

  it('diagnosticsFor resolves to [] promptly after close', async () => {
    const client = await startClient('never-publish');
    client.didOpen(URI, 'typescript', 'x');
    client.close();
    expect(await client.diagnosticsFor(URI, 1, WAIT)).toEqual([]);
  });
});
