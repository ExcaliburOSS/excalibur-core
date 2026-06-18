import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

/**
 * Language → default language-server command, file-extension → language, and a
 * dependency-free PATH check. v1 verifies TypeScript/JavaScript end-to-end; the
 * other servers are declared so they "just work" if their binary is installed,
 * but are inert (skipped by {@link binaryOnPath}) otherwise.
 */

export interface LspServerCommand {
  /** A stable key so TS+JS share one server instance. */
  serverKey: string;
  command: string;
  args: string[];
  /** The LSP `languageId` to tag opened documents with. */
  languageId: string;
}

/** Extension → language id (the key into {@link DEFAULT_SERVERS}). */
const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

/** Language → default server. TS and JS share the typescript-language-server. */
const DEFAULT_SERVERS: Readonly<Record<string, LspServerCommand>> = {
  typescript: { serverKey: 'typescript', command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescript' },
  javascript: { serverKey: 'typescript', command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascript' },
  python: { serverKey: 'python', command: 'pyright-langserver', args: ['--stdio'], languageId: 'python' },
  go: { serverKey: 'go', command: 'gopls', args: [], languageId: 'go' },
  rust: { serverKey: 'rust', command: 'rust-analyzer', args: [], languageId: 'rust' },
};

/** The language id for a file, by extension; null for unsupported files. */
export function languageForFile(filePath: string): string | null {
  return EXTENSION_LANGUAGE[extname(filePath).toLowerCase()] ?? null;
}

/**
 * Resolves the server command for a language, applying a per-language config
 * override (`{ command, args? }`). Returns null for an unknown language.
 */
export function resolveServerFor(
  language: string,
  overrides?: Record<string, { command: string; args?: string[] }>,
): LspServerCommand | null {
  const base = DEFAULT_SERVERS[language];
  const override = overrides?.[language];
  if (override !== undefined) {
    return {
      serverKey: base?.serverKey ?? language,
      command: override.command,
      args: override.args ?? base?.args ?? [],
      languageId: base?.languageId ?? language,
    };
  }
  return base ?? null;
}

/**
 * Resolves a command to an ABSOLUTE path: an absolute/relative path is checked
 * directly, otherwise each `PATH` entry is probed (with Windows executable
 * extensions). Returns null when not found. Dependency-free — no `which`.
 * Spawning the resolved absolute path (rather than the bare name) makes the
 * spawn independent of the child's own PATH handling.
 */
export function resolveBinary(command: string): string | null {
  if (command.length === 0) return null;
  const candidates =
    process.platform === 'win32'
      ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`]
      : [command];
  // Always return an ABSOLUTE path (via resolve): a PATH entry can be relative
  // (e.g. `./node_modules/.bin`), and we spawn with a different cwd, so a
  // relative result would resolve against the wrong directory.
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const hit = candidates.find((c) => existsSync(c));
    return hit !== undefined ? resolve(hit) : null;
  }
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const c of candidates) {
      const full = join(dir, c);
      if (existsSync(full)) return resolve(full);
    }
  }
  return null;
}

/** Whether a command is runnable (used to SKIP, never spawn, a missing server). */
export function binaryOnPath(command: string): boolean {
  return resolveBinary(command) !== null;
}
