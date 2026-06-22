import { execFile } from 'node:child_process';
import { resolveBinary } from './lsp-servers';

/**
 * Opt-in auto-install of a missing language server (P1.10b).
 *
 * Strictly gated by `lsp.autoInstall` (default OFF) — installing software hits
 * the network + mutates the global toolchain. Only servers with a DETERMINISTIC,
 * cross-platform install command (npm / go / rustup / gem / cargo / dotnet /
 * opam) are auto-installable; the rest (brew/ghcup/manual) only ever surface the
 * install hint. The exec is injected so the logic is unit-testable without
 * actually running a package manager.
 */

export interface LspInstallCommand {
  /** The package-manager binary (must be on PATH for the install to run). */
  manager: string;
  /** Argv passed to the manager (no shell — fixed args, never interpolated). */
  args: string[];
}

/** serverKey → the deterministic install command, when one exists. */
const LSP_INSTALL_COMMANDS: Readonly<Record<string, LspInstallCommand>> = {
  typescript: {
    manager: 'npm',
    args: ['install', '-g', 'typescript-language-server', 'typescript'],
  },
  python: { manager: 'npm', args: ['install', '-g', 'pyright'] },
  go: { manager: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] },
  rust: { manager: 'rustup', args: ['component', 'add', 'rust-analyzer'] },
  intelephense: { manager: 'npm', args: ['install', '-g', 'intelephense'] },
  bash: { manager: 'npm', args: ['install', '-g', 'bash-language-server'] },
  'vscode-langservers': { manager: 'npm', args: ['install', '-g', 'vscode-langservers-extracted'] },
  yaml: { manager: 'npm', args: ['install', '-g', 'yaml-language-server'] },
  vue: { manager: 'npm', args: ['install', '-g', '@vue/language-server'] },
  svelte: { manager: 'npm', args: ['install', '-g', 'svelte-language-server'] },
  'ruby-lsp': { manager: 'gem', args: ['install', 'ruby-lsp'] },
  csharp: { manager: 'dotnet', args: ['tool', 'install', '-g', 'csharp-ls'] },
  ocaml: { manager: 'opam', args: ['install', '-y', 'ocaml-lsp-server'] },
  taplo: { manager: 'cargo', args: ['install', 'taplo-cli', '--features', 'lsp'] },
};

/** The deterministic install command for a server, or null (manual-only). */
export function lspInstallCommand(serverKey: string): LspInstallCommand | null {
  return LSP_INSTALL_COMMANDS[serverKey] ?? null;
}

/** Runs an install command, resolving `{ ok }` — never throws. Injected in tests. */
export type LspInstallExec = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ ok: boolean; detail?: string }>;

const defaultExec: LspInstallExec = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeoutMs, windowsHide: true }, (error) => {
      resolve(
        error === null
          ? { ok: true }
          : { ok: false, detail: error instanceof Error ? error.message : String(error) },
      );
    });
  });

export interface InstallLspServerOptions {
  serverKey: string;
  timeoutMs: number;
  /** Runs the install (default: execFile). */
  exec?: LspInstallExec;
  /** Resolves a binary on PATH (default: resolveBinary) — injected in tests. */
  resolveBin?: (command: string) => string | null;
  /** Diagnostic sink (the adapter forwards this to a `policy_decision`/log event). */
  log?: (message: string) => void;
}

/**
 * Best-effort install of one language server. Returns `true` only when the
 * install command ran successfully. Skips (returns false) when the server has no
 * scriptable command or the package manager is not installed — logging why so
 * the user/agent can act. Never throws.
 */
export async function installLspServer(options: InstallLspServerOptions): Promise<boolean> {
  const cmd = lspInstallCommand(options.serverKey);
  if (cmd === null) {
    options.log?.(`no automatic installer for "${options.serverKey}" — install it manually.`);
    return false;
  }
  const resolveBin = options.resolveBin ?? resolveBinary;
  if (resolveBin(cmd.manager) === null) {
    options.log?.(`cannot auto-install "${options.serverKey}": "${cmd.manager}" is not on PATH.`);
    return false;
  }
  options.log?.(
    `auto-installing "${options.serverKey}" via \`${cmd.manager} ${cmd.args.join(' ')}\`…`,
  );
  const exec = options.exec ?? defaultExec;
  const result = await exec(cmd.manager, cmd.args, { timeoutMs: options.timeoutMs });
  options.log?.(
    result.ok
      ? `installed "${options.serverKey}".`
      : `auto-install of "${options.serverKey}" failed: ${result.detail ?? 'unknown error'}.`,
  );
  return result.ok;
}
