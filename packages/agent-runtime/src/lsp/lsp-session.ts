import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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
export interface LspSession {
  /** Non-blocking, idempotent: kick off the server for `language` if not already. */
  ensureStarted(language: string): void;
  /** Diagnostics for ONE just-edited repo-relative file; null when unavailable. */
  diagnosticsFor(relPath: string): Promise<DiagnosticsPayload | null>;
  /** Best-effort teardown of every started server. Safe from a `finally`. */
  close(): void;
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
          settleMs: 300,
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

    close(): void {
      for (const promise of clients.values()) {
        void promise.then((client) => client?.close()).catch(() => {});
      }
      clients.clear();
    },
  };
}
