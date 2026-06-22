import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LspConfig } from '@excalibur/shared';
import { createLspSession } from './lsp-session';
import { FAKE_LSP_SERVER } from './__fixtures__/fake-lsp-server';

// Replace the real installer (which would shell out to npm/go/…) with a spy, so
// the auto-install WIRING can be asserted hermetically. Tests with autoInstall
// off never reach it, so this is inert for the rest of the suite.
vi.mock('./lsp-install', () => ({ installLspServer: vi.fn(() => Promise.resolve(false)) }));
import { installLspServer } from './lsp-install';
const installMock = vi.mocked(installLspServer);

/**
 * Drives the session against the fake LSP server by pointing the `typescript`
 * server command at `node -e <fake server>` via a config override.
 */
function fakeConfig(extra: Partial<LspConfig> = {}): LspConfig {
  return {
    enabled: true,
    diagnosticsTimeoutMs: 2000,
    diagnosticsSettleMs: 200,
    serverStartTimeoutMs: 4000,
    autoInstall: false,
    autoInstallTimeoutMs: 180000,
    servers: { typescript: { command: process.execPath, args: ['-e', FAKE_LSP_SERVER] } },
    ...extra,
  };
}

describe('createLspSession', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'excalibur-lsp-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('opens then changes a file, returning 1-based diagnostics for an errored edit', async () => {
    const session = createLspSession({ workdir, config: fakeConfig() });
    try {
      // Clean file → no diagnostics.
      writeFileSync(join(workdir, 'a.ts'), 'const ok = 1;\n');
      const clean = await session.diagnosticsFor('a.ts');
      expect(clean).not.toBeNull();
      expect(clean?.errorCount).toBe(0);
      expect(clean?.diagnostics).toEqual([]);

      // Errored change → one error, 1-based line/column, severity 'error'.
      writeFileSync(join(workdir, 'a.ts'), '__ERR__ const x: number = "s";\n');
      const errored = await session.diagnosticsFor('a.ts');
      expect(errored?.file).toBe('a.ts');
      expect(errored?.errorCount).toBe(1);
      expect(errored?.diagnostics[0]).toMatchObject({
        line: 1,
        column: 7,
        severity: 'error',
        message: 'Type error',
        code: 'TS2322',
      });
    } finally {
      session.close();
    }
  });

  it('returns null for an unsupported file extension (no spawn)', async () => {
    const session = createLspSession({ workdir, config: fakeConfig() });
    try {
      writeFileSync(join(workdir, 'readme.md'), '# hi\n');
      expect(await session.diagnosticsFor('readme.md')).toBeNull();
    } finally {
      session.close();
    }
  });

  it('returns null (never spawns) when the server binary is missing', async () => {
    const session = createLspSession({
      workdir,
      config: fakeConfig({
        servers: { typescript: { command: 'definitely-not-installed-xyzzy' } },
      }),
    });
    try {
      writeFileSync(join(workdir, 'a.ts'), '__ERR__ bad\n');
      expect(await session.diagnosticsFor('a.ts')).toBeNull();
    } finally {
      session.close();
    }
  });

  it('does NOT attempt an install when autoInstall is off (the default)', async () => {
    installMock.mockClear();
    const session = createLspSession({
      workdir,
      config: fakeConfig({
        servers: { typescript: { command: 'definitely-not-installed-xyzzy' } },
      }),
    });
    try {
      writeFileSync(join(workdir, 'a.ts'), '__ERR__ bad\n');
      expect(await session.diagnosticsFor('a.ts')).toBeNull();
      expect(installMock).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
  });

  it('attempts a ONE-SHOT install when autoInstall is on and the binary is missing', async () => {
    installMock.mockClear();
    const logs: string[] = [];
    const session = createLspSession({
      workdir,
      config: fakeConfig({
        autoInstall: true,
        servers: { typescript: { command: 'definitely-not-installed-xyzzy' } },
      }),
      onLog: (m) => logs.push(m),
    });
    try {
      // Install mock resolves false → the server stays inert (no spawn).
      writeFileSync(join(workdir, 'a.ts'), '__ERR__ bad\n');
      expect(await session.diagnosticsFor('a.ts')).toBeNull();
      expect(installMock).toHaveBeenCalledTimes(1);
      expect(installMock).toHaveBeenCalledWith(
        expect.objectContaining({ serverKey: 'typescript', timeoutMs: 180000 }),
      );
      // A second edit of the SAME server must reuse the cached attempt, not re-install.
      writeFileSync(join(workdir, 'b.ts'), '__ERR__ bad\n');
      expect(await session.diagnosticsFor('b.ts')).toBeNull();
      expect(installMock).toHaveBeenCalledTimes(1);
    } finally {
      session.close();
    }
  });

  it('returns null when the edited file no longer exists on disk', async () => {
    const session = createLspSession({ workdir, config: fakeConfig() });
    try {
      expect(await session.diagnosticsFor('gone.ts')).toBeNull();
    } finally {
      session.close();
    }
  });
});
