import { ProviderError } from '@excalibur/shared';
import { LspStdioTransport, type LspIncomingMessage } from './lsp-transport';
import type {
  JsonRpcId,
  LspDiagnostic,
  OutgoingMessage,
  PublishDiagnosticsParams,
} from './lsp-protocol';

/**
 * A minimal LSP client over stdio — enough for per-edit diagnostics. It speaks
 * JSON-RPC 2.0 (request correlation mirrors the MCP client) but, unlike MCP,
 * MUST handle server-initiated traffic: it answers the server→client requests a
 * language server fires during init (`workspace/configuration`, capability
 * (un)registration, work-done progress) and consumes `publishDiagnostics`
 * notifications. Everything degrades gracefully — a crash/timeout never throws
 * into the agent loop (the session wraps calls in try/catch).
 */

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

type PublishWaiter = (params: PublishDiagnosticsParams) => void;

export interface LspClientStartOptions {
  command: string;
  args?: ReadonlyArray<string>;
  cwd: string;
  rootUri: string;
  rootPath: string;
  initializeTimeoutMs: number;
  requestTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface DiagnosticsWaitOptions {
  waitMs: number;
  settleMs: number;
  signal?: AbortSignal;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LspClient {
  private readonly transport: LspStdioTransport;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private closedReason: Error | null = null;

  /** Open documents: uri → current version (1-based, incremented on each change). */
  private readonly openDocs = new Map<string, number>();
  /** Last diagnostics published per uri. */
  private readonly latest = new Map<string, PublishDiagnosticsParams>();
  /** One-shot waiters resolved on the NEXT publish for a uri. */
  private readonly publishWaiters = new Map<string, PublishWaiter[]>();

  private constructor(transport: LspStdioTransport, requestTimeoutMs: number) {
    this.transport = transport;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /** Spawns the server, runs the initialize handshake, returns a ready client. */
  static async start(options: LspClientStartOptions): Promise<LspClient> {
    const transport = new LspStdioTransport({
      command: options.command,
      ...(options.args !== undefined ? { args: options.args } : {}),
      cwd: options.cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    const client = new LspClient(transport, options.requestTimeoutMs);
    transport.attach(
      (message) => client.handleMessage(message),
      (reason) => client.destroy(reason),
    );
    await client.initialize(options.rootUri, options.rootPath, options.initializeTimeoutMs);
    return client;
  }

  // ── handshake ───────────────────────────────────────────────────────────────

  private async initialize(rootUri: string, rootPath: string, timeoutMs: number): Promise<void> {
    await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'excalibur-agent-runtime', version: '0.1.0' },
        rootUri,
        rootPath,
        workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
          },
          workspace: {
            workspaceFolders: true,
            configuration: true,
            didChangeConfiguration: { dynamicRegistration: false },
          },
          window: { workDoneProgress: true },
        },
        initializationOptions: {},
      },
      timeoutMs,
    );
    this.notify('initialized', {});
  }

  // ── document sync (full-text) ────────────────────────────────────────────────

  isOpen(uri: string): boolean {
    return this.openDocs.has(uri);
  }

  didOpen(uri: string, languageId: string, text: string): number {
    this.openDocs.set(uri, 1);
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    return 1;
  }

  didChange(uri: string, text: string): number {
    const version = (this.openDocs.get(uri) ?? 0) + 1;
    this.openDocs.set(uri, version);
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return version;
  }

  didClose(uri: string): void {
    if (!this.openDocs.has(uri)) return;
    this.openDocs.delete(uri);
    this.latest.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /**
   * Waits for the diagnostics of a JUST-changed document. Algorithm (the crux):
   * wait for the NEXT `publishDiagnostics` for `uri` after our change; if it
   * carries a `version` older than `sentVersion`, ignore it (a stale wave); on
   * the first acceptable publish, wait a short SETTLE window for a later wave —
   * tsserver emits a syntactic (often empty) pass, then the semantic errors —
   * and take the last. `waitMs` bounds the wait for the FIRST publish; the
   * settle then adds up to `2 × settleMs` MORE (deliberately past `waitMs`, so a
   * semantic wave that lands just after a late syntactic pass isn't missed) —
   * total ceiling `waitMs + 2·settleMs`, still hard-bounded and abortable. On
   * timeout returns the last-acceptable (or empty = a real "clean" signal).
   * Never throws.
   */
  async diagnosticsFor(
    uri: string,
    sentVersion: number,
    options: DiagnosticsWaitOptions,
  ): Promise<LspDiagnostic[]> {
    const acceptable = (p: PublishDiagnosticsParams): boolean =>
      p.version === undefined || p.version >= sentVersion;
    const deadline = Date.now() + options.waitMs;
    let best: PublishDiagnosticsParams | null = null;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const published = await this.waitForPublish(uri, remaining, options.signal);
      if (published === null) {
        break; // timeout / abort / closed
      }
      if (!acceptable(published)) {
        continue; // a stale wave from before our change
      }
      best = published;
      // Settle: catch the semantic wave that follows a syntactic-only pass.
      for (let round = 0; round < 2; round += 1) {
        const more = await this.waitForPublish(uri, options.settleMs, options.signal);
        if (more === null) break;
        if (acceptable(more)) best = more;
      }
      break;
    }
    return best?.diagnostics ?? [];
  }

  /** Resolves on the next `publishDiagnostics(uri)`, or null on timeout/abort/close. */
  private waitForPublish(
    uri: string,
    ms: number,
    signal?: AbortSignal,
  ): Promise<PublishDiagnosticsParams | null> {
    return new Promise((resolve) => {
      if (this.closedReason !== null || ms <= 0 || signal?.aborted === true) {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (value: PublishDiagnosticsParams | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const list = this.publishWaiters.get(uri);
        if (list !== undefined) {
          const idx = list.indexOf(waiter);
          if (idx >= 0) list.splice(idx, 1);
        }
        resolve(value);
      };
      const waiter: PublishWaiter = (params) => finish(params);
      const onAbort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), ms);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      const list = this.publishWaiters.get(uri) ?? [];
      list.push(waiter);
      this.publishWaiters.set(uri, list);
    });
  }

  // ── on-demand queries (P1.8b `lsp` tool) ─────────────────────────────────────
  // textDocument/{definition,references,hover} for an OPEN document. The caller
  // (LspSession.queryFor) opens/syncs the doc first. `position` is 0-based.

  /** Go-to-definition: returns Location | Location[] | LocationLink[] (server-shaped). */
  definition(uri: string, position: { line: number; character: number }): Promise<unknown> {
    return this.request('textDocument/definition', { textDocument: { uri }, position });
  }

  /** Find references (including the declaration). Returns Location[] | null. */
  references(uri: string, position: { line: number; character: number }): Promise<unknown> {
    return this.request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
  }

  /** Hover info (type/signature/docs). Returns Hover | null. */
  hover(uri: string, position: { line: number; character: number }): Promise<unknown> {
    return this.request('textDocument/hover', { textDocument: { uri }, position });
  }

  // ── JSON-RPC plumbing ─────────────────────────────────────────────────────────

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closedReason !== null) {
      return Promise.reject(this.closedReason);
    }
    const id = this.nextId++;
    const limit = timeoutMs ?? this.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProviderError(`LSP request "${method}" timed out after ${limit}ms.`, {
            code: 'lsp_timeout',
            details: { method },
          }),
        );
      }, limit);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new ProviderError(describe(error), { code: 'lsp_write_failed' }),
        );
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    try {
      this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    } catch {
      // A notification is best-effort; a write failure surfaces on the next request.
    }
  }

  private send(message: OutgoingMessage): void {
    if (this.closedReason !== null) throw this.closedReason;
    this.transport.send(message);
  }

  private handleMessage(message: LspIncomingMessage): void {
    if (!isObject(message) || message['jsonrpc'] !== '2.0') {
      return;
    }
    const hasId = 'id' in message && message['id'] !== null && message['id'] !== undefined;
    const hasMethod = typeof message['method'] === 'string';

    if (hasMethod && hasId) {
      this.handleServerRequest(
        message['id'] as JsonRpcId,
        message['method'] as string,
        message['params'],
      );
      return;
    }
    if (hasMethod) {
      this.handleNotification(message['method'] as string, message['params']);
      return;
    }
    if (hasId) {
      this.handleResponse(message['id'] as JsonRpcId, message);
    }
  }

  /** Answers the server→client requests a language server needs during init. */
  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    let result: unknown = null;
    switch (method) {
      case 'workspace/configuration': {
        const items = isObject(params) && Array.isArray(params['items']) ? params['items'] : [];
        result = items.map(() => null); // one (null) config per requested item
        break;
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        result = null;
        break;
      default:
        // Method we don't implement — reply with a proper JSON-RPC error so the
        // server isn't left waiting.
        this.respondError(id, -32601, `method not found: ${method}`);
        return;
    }
    this.respond(id, result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'textDocument/publishDiagnostics' || !isObject(params)) {
      return; // window/logMessage, $/progress, telemetry/event, … — ignored
    }
    const uri = typeof params['uri'] === 'string' ? params['uri'] : null;
    if (uri === null) return;
    const published: PublishDiagnosticsParams = {
      uri,
      ...(typeof params['version'] === 'number' ? { version: params['version'] } : {}),
      diagnostics: Array.isArray(params['diagnostics'])
        ? (params['diagnostics'] as LspDiagnostic[])
        : [],
    };
    this.latest.set(uri, published);
    const waiters = this.publishWaiters.get(uri);
    if (waiters !== undefined && waiters.length > 0) {
      // Snapshot + clear before invoking (each waiter removes itself too).
      const snapshot = [...waiters];
      this.publishWaiters.set(uri, []);
      for (const waiter of snapshot) waiter(published);
    }
  }

  private handleResponse(id: JsonRpcId, message: LspIncomingMessage): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (isObject(message['error'])) {
      const err = message['error'] as { code?: number; message?: string };
      pending.reject(
        new ProviderError(
          `LSP "${pending.method}" failed: ${err.message ?? 'error'} (code ${err.code ?? -1}).`,
          {
            code: 'lsp_rpc_error',
            details: { method: pending.method, rpcCode: err.code },
          },
        ),
      );
      return;
    }
    pending.resolve(message['result'] ?? null);
  }

  private respond(id: JsonRpcId, result: unknown): void {
    try {
      this.send({ jsonrpc: '2.0', id, result });
    } catch {
      /* the server is gone; teardown will follow via onClose */
    }
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    try {
      this.send({ jsonrpc: '2.0', id, error: { code, message } });
    } catch {
      /* ignore */
    }
  }

  // ── teardown ──────────────────────────────────────────────────────────────────

  /** Best-effort graceful shutdown, then a hard teardown. Safe from a `finally`. */
  close(): void {
    if (this.closedReason === null) {
      // Politely ask the server to shut down (don't await), then exit; the
      // transport's SIGTERM in destroy() guarantees the process dies regardless.
      this.notify('exit');
    }
    this.destroy(new ProviderError('LSP client closed.', { code: 'lsp_closed' }));
  }

  private destroy(reason: Error): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    // Any in-flight diagnostics waiters settle to null via their own (bounded,
    // unref'd) timeout — no publish will ever come once the server is gone.
    this.publishWaiters.clear();
    try {
      this.transport.close();
    } catch {
      /* already torn down */
    }
  }
}
