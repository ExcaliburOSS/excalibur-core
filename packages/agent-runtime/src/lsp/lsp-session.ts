import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DiagnosticsPayload, DiagnosticItem, LspConfig } from '@excalibur/shared';
import { LspClient } from './lsp-client';
import { LSP_SEVERITY, type DiagnosticSeverity, type LspDiagnostic } from './lsp-protocol';
import { languageForFile, resolveBinary, resolveServerFor } from './lsp-servers';

/**
 * Run-scoped LSP orchestrator: the adapter holds one of these and asks it for
 * diagnostics after each edit. Lazy (no server spawns until the first edit of a
 * supported language) and TOTALLY graceful — a missing binary, a slow/crashed
 * server, a read error or a timeout all resolve to `null`, never an exception,
 * so the agent loop is never blocked or broken. An `LspSession` interface lets
 * the adapter tests inject a fake.
 */
/** A resolved code location, repo-relative + 1-based (model-friendly). */
export interface LspLocation {
  file: string;
  line: number;
  column: number;
}

/** The kind of on-demand query the `lsp` tool can issue (P1.8b). */
export type LspQueryKind = 'definition' | 'references' | 'hover';

/** Normalized result of an {@link LspSession.queryFor} call. */
export interface LspQueryResult {
  kind: LspQueryKind;
  /** definition/references → resolved locations (empty if none found). */
  locations?: LspLocation[];
  /** hover → the hover text (markdown/plaintext), or null if none. */
  hover?: string | null;
}

export interface LspSession {
  /** Non-blocking, idempotent: kick off the server for `language` if not already. */
  ensureStarted(language: string): void;
  /** Diagnostics for ONE just-edited repo-relative file; null when unavailable. */
  diagnosticsFor(relPath: string): Promise<DiagnosticsPayload | null>;
  /**
   * On-demand code intelligence (P1.8b `lsp` tool): definition / references /
   * hover at a 1-based (line,column) in a repo-relative file. TOTALLY graceful —
   * an unknown language, missing server, read error or timeout resolve to `null`.
   */
  queryFor(
    relPath: string,
    line: number,
    column: number,
    kind: LspQueryKind,
  ): Promise<LspQueryResult | null>;
  /** Best-effort teardown of every started server. Safe from a `finally`. */
  close(): void;
}

/** LSP Position (0-based). */
interface LspPosition {
  line: number;
  character: number;
}
interface LspRawLocation {
  uri?: string;
  targetUri?: string;
  range?: { start: LspPosition };
  targetRange?: { start: LspPosition };
  targetSelectionRange?: { start: LspPosition };
}

/** Maps an LSP Location / LocationLink to a repo-relative, 1-based location. */
function toLocation(workdir: string, raw: LspRawLocation): LspLocation | null {
  const uri = raw.uri ?? raw.targetUri;
  const range = raw.targetSelectionRange ?? raw.targetRange ?? raw.range;
  if (typeof uri !== 'string' || range === undefined) {
    return null;
  }
  let abs: string;
  try {
    abs = fileURLToPath(uri);
  } catch {
    return null;
  }
  const rel = relative(workdir, abs);
  return {
    file: rel === '' ? abs : rel,
    line: range.start.line + 1,
    column: range.start.character + 1,
  };
}

/** Extracts a plain string from an LSP Hover.contents (string | MarkupContent | array). */
function hoverText(hover: unknown): string | null {
  if (hover === null || typeof hover !== 'object') {
    return null;
  }
  const contents = (hover as { contents?: unknown }).contents;
  const part = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (c !== null && typeof c === 'object') {
      const v = (c as { value?: unknown }).value;
      if (typeof v === 'string') return v;
    }
    return '';
  };
  const text = Array.isArray(contents)
    ? contents
        .map(part)
        .filter((s) => s.length > 0)
        .join('\n\n')
    : part(contents);
  return text.trim().length > 0 ? text.trim() : null;
}

export interface CreateLspSessionOptions {
  workdir: string;
  config: LspConfig;
  signal?: AbortSignal;
}

/** Files larger than this are skipped (a language server choke + low value). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function severityOf(diagnostic: LspDiagnostic): DiagnosticSeverity {
  const sev = diagnostic.severity;
  if (sev === 1 || sev === 2 || sev === 3 || sev === 4) {
    return LSP_SEVERITY[sev];
  }
  return 'error'; // unlabeled diagnostics are surfaced conservatively
}

export function createLspSession(options: CreateLspSessionOptions): LspSession {
  const { workdir, config } = options;
  // serverKey → a promise of its client (or null if it could not start). Caching
  // the PROMISE makes ensureStarted idempotent and de-duplicates concurrent edits;
  // caching a resolved null means a missing binary is never retried.
  const clients = new Map<string, Promise<LspClient | null>>();

  function startFor(language: string): Promise<LspClient | null> {
    const server = resolveServerFor(language, config.servers);
    const resolvedCommand = server === null ? null : resolveBinary(server.command);
    if (server === null || resolvedCommand === null) {
      return Promise.resolve(null); // unknown language or no server installed → inert
    }
    const existing = clients.get(server.serverKey);
    if (existing !== undefined) {
      return existing;
    }
    const rootUri = pathToFileURL(workdir).href;
    const started = LspClient.start({
      // Spawn the RESOLVED absolute path so the spawn doesn't depend on the
      // child's own PATH search (robust across shells / test workers).
      command: resolvedCommand,
      args: server.args,
      cwd: workdir,
      rootUri,
      rootPath: workdir,
      initializeTimeoutMs: config.serverStartTimeoutMs,
      requestTimeoutMs: config.serverStartTimeoutMs,
      env: { ...process.env },
    }).catch(() => null); // start failure → inert (never throws into the loop)
    clients.set(server.serverKey, started);
    return started;
  }

  return {
    ensureStarted(language: string): void {
      void startFor(language);
    },

    async diagnosticsFor(relPath: string): Promise<DiagnosticsPayload | null> {
      try {
        const language = languageForFile(relPath);
        if (language === null) {
          return null;
        }
        const server = resolveServerFor(language, config.servers);
        if (server === null) {
          return null;
        }
        const client = await startFor(language);
        if (client === null) {
          return null;
        }
        const abs = resolve(workdir, relPath);
        const uri = pathToFileURL(abs).href;

        let text: string;
        try {
          if (statSync(abs).size > MAX_FILE_BYTES) {
            return null;
          }
          text = readFileSync(abs, 'utf8');
        } catch {
          // The file was deleted/renamed by the edit — let the server forget it.
          client.didClose(uri);
          return null;
        }

        const version = client.isOpen(uri)
          ? client.didChange(uri, text)
          : client.didOpen(uri, server.languageId, text);

        const diagnostics = await client.diagnosticsFor(uri, version, {
          waitMs: config.diagnosticsTimeoutMs,
          settleMs: config.diagnosticsSettleMs,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });

        const items: DiagnosticItem[] = diagnostics.map((d) => ({
          line: d.range.start.line + 1, // LSP is 0-based; surface 1-based
          column: d.range.start.character + 1,
          severity: severityOf(d),
          message: d.message,
          ...(d.code !== undefined ? { code: String(d.code) } : {}),
        }));
        return {
          file: relPath,
          diagnostics: items,
          errorCount: items.filter((i) => i.severity === 'error').length,
          warningCount: items.filter((i) => i.severity === 'warning').length,
        };
      } catch {
        return null; // any unexpected failure → silently skip diagnostics this edit
      }
    },

    async queryFor(
      relPath: string,
      line: number,
      column: number,
      kind: LspQueryKind,
    ): Promise<LspQueryResult | null> {
      try {
        const language = languageForFile(relPath);
        if (language === null) {
          return null;
        }
        const server = resolveServerFor(language, config.servers);
        if (server === null) {
          return null;
        }
        const client = await startFor(language);
        if (client === null) {
          return null;
        }
        const abs = resolve(workdir, relPath);
        const uri = pathToFileURL(abs).href;

        let text: string;
        try {
          if (statSync(abs).size > MAX_FILE_BYTES) {
            return null;
          }
          text = readFileSync(abs, 'utf8');
        } catch {
          return null; // file gone — nothing to query
        }
        // Sync the document so the server resolves the position against current text.
        if (client.isOpen(uri)) {
          client.didChange(uri, text);
        } else {
          client.didOpen(uri, server.languageId, text);
        }

        // The model speaks 1-based; LSP is 0-based.
        const position: LspPosition = {
          line: Math.max(0, line - 1),
          character: Math.max(0, column - 1),
        };

        if (kind === 'hover') {
          const raw = await client.hover(uri, position);
          return { kind, hover: hoverText(raw) };
        }
        const raw =
          kind === 'definition'
            ? await client.definition(uri, position)
            : await client.references(uri, position);
        const list: LspRawLocation[] = Array.isArray(raw)
          ? (raw as LspRawLocation[])
          : raw !== null && typeof raw === 'object'
            ? [raw as LspRawLocation]
            : [];
        const locations = list
          .map((loc) => toLocation(workdir, loc))
          .filter((loc): loc is LspLocation => loc !== null);
        return { kind, locations };
      } catch {
        return null; // any failure → graceful null (never breaks the loop)
      }
    },

    close(): void {
      for (const promise of clients.values()) {
        void promise.then((client) => client?.close()).catch(() => {});
      }
      clients.clear();
    },
  };
}
