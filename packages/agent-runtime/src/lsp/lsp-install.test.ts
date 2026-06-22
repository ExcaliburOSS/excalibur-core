import { describe, expect, it, vi } from 'vitest';
import { installLspServer, lspInstallCommand, type LspInstallExec } from './lsp-install';

describe('lspInstallCommand', () => {
  it('maps known servers to a deterministic package-manager command', () => {
    expect(lspInstallCommand('typescript')).toEqual({
      manager: 'npm',
      args: ['install', '-g', 'typescript-language-server', 'typescript'],
    });
    expect(lspInstallCommand('go')).toEqual({
      manager: 'go',
      args: ['install', 'golang.org/x/tools/gopls@latest'],
    });
    expect(lspInstallCommand('rust')).toEqual({
      manager: 'rustup',
      args: ['component', 'add', 'rust-analyzer'],
    });
    expect(lspInstallCommand('ruby-lsp')?.manager).toBe('gem');
  });

  it('returns null for manual-only servers', () => {
    // clangd/jdtls/lua etc. have no cross-platform scriptable installer.
    expect(lspInstallCommand('clangd')).toBeNull();
    expect(lspInstallCommand('lua')).toBeNull();
    expect(lspInstallCommand('totally-unknown')).toBeNull();
  });
});

describe('installLspServer', () => {
  const ok: LspInstallExec = () => Promise.resolve({ ok: true });

  it('runs the install command when the package manager is present', async () => {
    const exec = vi.fn<LspInstallExec>(() => Promise.resolve({ ok: true }));
    const log: string[] = [];
    const result = await installLspServer({
      serverKey: 'typescript',
      timeoutMs: 1000,
      exec,
      resolveBin: () => '/usr/bin/npm', // npm is on PATH
      log: (m) => log.push(m),
    });
    expect(result).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', 'typescript-language-server', 'typescript'],
      { timeoutMs: 1000 },
    );
    expect(log.some((m) => m.includes('installed'))).toBe(true);
  });

  it('skips (without running) when the package manager is missing', async () => {
    const exec = vi.fn<LspInstallExec>(ok);
    const log: string[] = [];
    const result = await installLspServer({
      serverKey: 'go',
      timeoutMs: 1000,
      exec,
      resolveBin: () => null, // go not installed
      log: (m) => log.push(m),
    });
    expect(result).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(log.some((m) => m.includes('not on PATH'))).toBe(true);
  });

  it('reports failure when the install command errors', async () => {
    const exec: LspInstallExec = () => Promise.resolve({ ok: false, detail: 'network down' });
    const log: string[] = [];
    const result = await installLspServer({
      serverKey: 'python',
      timeoutMs: 1000,
      exec,
      resolveBin: () => '/usr/bin/npm',
      log: (m) => log.push(m),
    });
    expect(result).toBe(false);
    expect(log.some((m) => m.includes('failed') && m.includes('network down'))).toBe(true);
  });

  it('refuses servers with no scriptable installer', async () => {
    const exec = vi.fn<LspInstallExec>(ok);
    const result = await installLspServer({
      serverKey: 'clangd',
      timeoutMs: 1000,
      exec,
      resolveBin: () => '/usr/bin/anything',
    });
    expect(result).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});
