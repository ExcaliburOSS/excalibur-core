import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

/**
 * User-defined custom slash commands (P1.6).
 *
 * A markdown file `<name>.md` under `.excalibur/commands/` (project) or
 * `~/.config/excalibur/commands/` (user-global) defines a `/name` command whose
 * body is a prompt template. The body supports:
 *  - `$ARGUMENTS` — all args after the command, space-joined;
 *  - `$1`,`$2`,… — positional args;
 *  - `` !`shell cmd` `` — replaced with the command's stdout (run in the repo);
 *  - `@path` — replaced with the contents of that file (relative to the repo).
 * Optional YAML front matter provides `description` (shown in help/completion).
 *
 * Project commands override user-global ones on a name clash. Built-in slash
 * commands always win (the REPL only consults this registry as a fallthrough).
 */

/** One loaded custom command. */
export interface CustomCommand {
  /** Lowercase command name (the file basename without `.md`). */
  name: string;
  /** One-line description (front-matter `description`, else first body line). */
  description: string;
  /** The raw template body (front matter stripped). */
  body: string;
  /** Where it came from (project overrides global). */
  source: 'project' | 'global';
  /** Absolute path to the source file. */
  path: string;
}

/** Runs a shell command and resolves its stdout (injected for tests). */
export type CommandExec = (command: string) => Promise<string>;

const execFileAsync = promisify(execFile);

/** Default exec: runs `<cmd>` via `sh -c` in the given cwd, returns stdout. */
export function shellExecIn(cwd: string): CommandExec {
  return async (command: string): Promise<string> => {
    const { stdout } = await execFileAsync('sh', ['-c', command], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout;
  };
}

/** Splits optional `---` YAML front matter from the markdown body. */
function parseFrontMatter(content: string): { description: string; body: string } {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (match !== null) {
    let description = '';
    try {
      const meta = parseYaml(match[1] as string) as { description?: unknown } | null;
      if (meta !== null && typeof meta.description === 'string') {
        description = meta.description.trim();
      }
    } catch {
      /* malformed front matter → treat as no description */
    }
    const body = (match[2] ?? '').trim();
    return { description: description.length > 0 ? description : firstLine(body), body };
  }
  const body = normalized.trim();
  return { description: firstLine(body), body };
}

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 120);
}

function scanDir(
  dir: string,
  source: 'project' | 'global',
  into: Map<string, CustomCommand>,
): void {
  if (!existsSync(dir)) {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /\.md$/i.test(f));
  } catch {
    return;
  }
  for (const file of names) {
    const name = basename(file, '.md').toLowerCase();
    if (name.length === 0) continue;
    try {
      const { description, body } = parseFrontMatter(readFileSync(join(dir, file), 'utf8'));
      into.set(name, { name, description, body, source, path: join(dir, file) });
    } catch {
      /* skip an unreadable command file */
    }
  }
}

/** Options for {@link loadCustomCommands}. */
export interface LoadCustomCommandsOptions {
  repoRoot: string;
  /** Home dir for the user-global `~/.config/excalibur/commands/` scan. */
  homeDir?: string;
  /** Include the user-global scan (off by default for hermetic behavior). */
  includeGlobal?: boolean;
}

/**
 * Loads custom commands from the project dir (and optionally the user-global
 * dir). Project commands override user-global ones on a name clash.
 */
export function loadCustomCommands(options: LoadCustomCommandsOptions): Map<string, CustomCommand> {
  const commands = new Map<string, CustomCommand>();
  // Global first so project entries override on a name collision.
  if (options.includeGlobal === true && options.homeDir !== undefined) {
    scanDir(join(options.homeDir, '.config', 'excalibur', 'commands'), 'global', commands);
  }
  scanDir(join(options.repoRoot, '.excalibur', 'commands'), 'project', commands);
  return commands;
}

/** Async string replace (the built-in replace can't await an async replacer). */
async function replaceAsync(
  input: string,
  regex: RegExp,
  replacer: (match: RegExpMatchArray) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(regex)];
  let result = '';
  let last = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    result += input.slice(last, index);
    result += await replacer(match);
    last = index + match[0].length;
  }
  result += input.slice(last);
  return result;
}

/** Options for {@link expandCustomCommand}. */
export interface ExpandCommandOptions {
  argv: string[];
  repoRoot: string;
  /** Shell exec for `` !`cmd` `` (defaults to `sh -c` in repoRoot). */
  exec?: CommandExec;
  /** File reader for `@path` (defaults to fs, repo-confined). */
  readFile?: (absPath: string) => string;
}

/**
 * Expands a command body: positional/`$ARGUMENTS` args, then `@file` inclusion,
 * then `` !`cmd` `` shell substitution (so `@$1` / `` !`grep $1` `` work). A failed
 * file read leaves the `@token` literal; a failed command yields a `[failed]` note.
 */
export async function expandCustomCommand(
  body: string,
  options: ExpandCommandOptions,
): Promise<string> {
  const exec = options.exec ?? shellExecIn(options.repoRoot);
  const readFile = options.readFile ?? ((p: string): string => readFileSync(p, 'utf8'));
  const argv = options.argv;

  // 1. Args (do these first so `@$1` / `` !`cmd $1` `` resolve).
  let out = body.replace(/\$ARGUMENTS\b/g, argv.join(' '));
  out = out.replace(/\$(\d+)/g, (_m, n: string) => argv[Number.parseInt(n, 10) - 1] ?? '');

  // 2. @file inclusion (repo-confined; unreadable → keep the literal token).
  out = await replaceAsync(out, /@([\w./-]+)/g, (match) => {
    const rel = match[1] as string;
    const abs = isAbsolute(rel) ? rel : resolve(options.repoRoot, rel);
    // Confine to the repo: a traversal outside is left literal.
    if (!abs.startsWith(resolve(options.repoRoot))) {
      return Promise.resolve(match[0]);
    }
    try {
      return Promise.resolve(readFile(abs));
    } catch {
      return Promise.resolve(match[0]);
    }
  });

  // 3. !`cmd` inline shell output.
  out = await replaceAsync(out, /!`([^`]+)`/g, async (match) => {
    try {
      return (await exec(match[1] as string)).trim();
    } catch (error) {
      return `[command failed: ${error instanceof Error ? error.message : String(error)}]`;
    }
  });

  return out;
}
