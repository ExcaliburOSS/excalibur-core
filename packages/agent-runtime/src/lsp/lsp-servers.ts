import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

/**
 * Language → default language-server command, file-extension → language, a
 * dependency-free PATH check, and the precise install hint per server.
 *
 * Coverage spans ~28 languages (P1.10). Every server is declared so it "just
 * works" when its binary is on PATH, and is inert (skipped by
 * {@link binaryOnPath}) otherwise — but rather than failing silently, callers
 * surface {@link installHintFor} so the user/agent is told EXACTLY how to
 * install the missing server. TypeScript/JavaScript is verified end-to-end.
 */

export interface LspServerCommand {
  /** A stable key so TS+JS (etc.) share one server instance. */
  serverKey: string;
  command: string;
  args: string[];
  /** The LSP `languageId` to tag opened documents with. */
  languageId: string;
}

/** Extension → language id (the key into {@link DEFAULT_SERVERS}). */
const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  // TypeScript / JavaScript
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // Python
  '.py': 'python',
  '.pyi': 'python',
  // Go / Rust
  '.go': 'go',
  '.rs': 'rust',
  // C / C++
  '.c': 'c',
  '.h': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  // JVM
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sbt': 'scala',
  // Scripting / web
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  // .NET
  '.cs': 'csharp',
  // Functional
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.hs': 'haskell',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',
  // Systems / mobile
  '.swift': 'swift',
  '.zig': 'zig',
  '.dart': 'dart',
  // Data / config / markup
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.md': 'markdown',
  '.markdown': 'markdown',
};

function stdio(serverKey: string, command: string, languageId: string): LspServerCommand {
  return { serverKey, command, args: ['--stdio'], languageId };
}
function bare(
  serverKey: string,
  command: string,
  languageId: string,
  args: string[] = [],
): LspServerCommand {
  return { serverKey, command, args, languageId };
}

/**
 * Language → default server. Servers that share a binary share a `serverKey`
 * (TS+JS; the vscode-langservers-extracted family: json/css/html).
 */
const DEFAULT_SERVERS: Readonly<Record<string, LspServerCommand>> = {
  typescript: stdio('typescript', 'typescript-language-server', 'typescript'),
  javascript: stdio('typescript', 'typescript-language-server', 'javascript'),
  python: stdio('python', 'pyright-langserver', 'python'),
  go: bare('go', 'gopls', 'go'),
  rust: bare('rust', 'rust-analyzer', 'rust'),
  c: bare('clangd', 'clangd', 'c'),
  cpp: bare('clangd', 'clangd', 'cpp'),
  java: bare('jdtls', 'jdtls', 'java'),
  kotlin: bare('kotlin', 'kotlin-language-server', 'kotlin'),
  scala: bare('metals', 'metals', 'scala'),
  ruby: bare('ruby-lsp', 'ruby-lsp', 'ruby'),
  php: stdio('intelephense', 'intelephense', 'php'),
  lua: bare('lua', 'lua-language-server', 'lua'),
  shell: bare('bash', 'bash-language-server', 'shellscript', ['start']),
  csharp: bare('csharp', 'csharp-ls', 'csharp'),
  elixir: bare('elixir-ls', 'language_server.sh', 'elixir'),
  haskell: bare('haskell', 'haskell-language-server-wrapper', 'haskell', ['--lsp']),
  ocaml: bare('ocaml', 'ocamllsp', 'ocaml'),
  clojure: bare('clojure', 'clojure-lsp', 'clojure'),
  swift: bare('sourcekit', 'sourcekit-lsp', 'swift'),
  zig: bare('zig', 'zls', 'zig'),
  dart: bare('dart', 'dart', 'dart', ['language-server', '--protocol=lsp']),
  json: stdio('vscode-langservers', 'vscode-json-language-server', 'json'),
  yaml: stdio('yaml', 'yaml-language-server', 'yaml'),
  toml: bare('taplo', 'taplo', 'toml', ['lsp', 'stdio']),
  html: stdio('vscode-langservers', 'vscode-html-language-server', 'html'),
  css: stdio('vscode-langservers', 'vscode-css-language-server', 'css'),
  vue: stdio('vue', 'vue-language-server', 'vue'),
  svelte: bare('svelte', 'svelteserver', 'svelte', ['--stdio']),
  terraform: bare('terraform', 'terraform-ls', 'terraform', ['serve']),
  markdown: bare('marksman', 'marksman', 'markdown', ['server']),
};

/**
 * Per-server install hint (the exact command to install the missing server).
 * Keyed by `serverKey`. Surfaced by {@link installHintFor} when a language is
 * recognized but its server binary is not on PATH — so "unsupported" becomes
 * "run this to enable it".
 */
const INSTALL_HINTS: Readonly<Record<string, string>> = {
  typescript: 'npm i -g typescript-language-server typescript',
  python: 'npm i -g pyright',
  go: 'go install golang.org/x/tools/gopls@latest',
  rust: 'rustup component add rust-analyzer',
  clangd: 'install clangd (LLVM): e.g. `brew install llvm` or `apt install clangd`',
  jdtls: 'install Eclipse JDT LS (jdtls): e.g. `brew install jdtls`',
  kotlin: 'install kotlin-language-server: e.g. `brew install kotlin-language-server`',
  metals: 'install Scala Metals: `cs install metals` (Coursier)',
  'ruby-lsp': 'gem install ruby-lsp',
  intelephense: 'npm i -g intelephense',
  lua: 'install lua-language-server: e.g. `brew install lua-language-server`',
  bash: 'npm i -g bash-language-server',
  csharp: 'dotnet tool install -g csharp-ls',
  'elixir-ls': 'install elixir-ls and put language_server.sh on PATH',
  haskell: 'install haskell-language-server via ghcup: `ghcup install hls`',
  ocaml: 'opam install ocaml-lsp-server',
  clojure: 'install clojure-lsp: e.g. `brew install clojure-lsp/brew/clojure-lsp-native`',
  sourcekit: 'install Swift toolchain (sourcekit-lsp ships with it)',
  zig: 'install zls (Zig Language Server): https://github.com/zigtools/zls',
  dart: 'install the Dart SDK (dart ships the language server)',
  'vscode-langservers': 'npm i -g vscode-langservers-extracted',
  yaml: 'npm i -g yaml-language-server',
  taplo: 'cargo install taplo-cli --features lsp  (or `brew install taplo`)',
  vue: 'npm i -g @vue/language-server',
  svelte: 'npm i -g svelte-language-server',
  terraform: 'install terraform-ls: e.g. `brew install hashicorp/tap/terraform-ls`',
  marksman: 'install marksman: e.g. `brew install marksman`',
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

/**
 * Diagnoses the LSP availability for a file and, when the language is known but
 * the server is not installed, returns the precise install command. Lets callers
 * turn a silent "no server" into actionable guidance.
 *
 * Returns `{ status: 'unsupported' }` for an unknown file type,
 * `{ status: 'ready' }` when a server is installed, or
 * `{ status: 'missing', command, install }` when the server is known but absent.
 */
export function lspAvailabilityFor(
  filePath: string,
  overrides?: Record<string, { command: string; args?: string[] }>,
):
  | { status: 'unsupported' }
  | { status: 'ready' }
  | {
      status: 'missing';
      language: string;
      command: string;
      install: string | null;
    } {
  const language = languageForFile(filePath);
  if (language === null) {
    return { status: 'unsupported' };
  }
  const server = resolveServerFor(language, overrides);
  if (server === null) {
    return { status: 'unsupported' };
  }
  if (binaryOnPath(server.command)) {
    return { status: 'ready' };
  }
  return {
    status: 'missing',
    language,
    command: server.command,
    install: INSTALL_HINTS[server.serverKey] ?? null,
  };
}

/** The install command for a language's server, or null if unknown. */
export function installHintFor(language: string): string | null {
  const server = DEFAULT_SERVERS[language];
  return server === undefined ? null : (INSTALL_HINTS[server.serverKey] ?? null);
}
