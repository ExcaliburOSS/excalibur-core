/**
 * Minimal Agent Client Protocol (ACP) client for the Excalibur VS Code
 * extension (P1.5).
 *
 * ACP is JSON-RPC 2.0 over newline-delimited stdio: the editor spawns
 * `excalibur acp` as a subprocess and exchanges one JSON message per line on
 * its stdin/stdout. This client implements exactly the contract the Excalibur
 * ACP server speaks (see apps/cli/src/lib/acp-server.ts):
 *
 *   client → server requests:  initialize · authenticate · session/new · session/prompt
 *   client → server notify:    session/cancel
 *   server → client notify:    session/update   (agent_message_chunk · tool_call · tool_call_update · plan)
 *   server → client request:   session/request_permission   (client must reply with the chosen optionId)
 *
 * The transport is injected so the protocol logic is testable without spawning a
 * real process — this module never imports `vscode` or `child_process`, keeping
 * it pure and unit-testable; the extension wires a real stdio transport on top.
 */

/** A bidirectional newline-delimited message transport (one JSON object per line). */
export interface AcpTransport {
  /** Write one already-serialized JSON-RPC message (without the trailing newline). */
  send(message: string): void;
  /** Register a handler for each inbound line (the impl strips the newline). */
  onLine(handler: (line: string) => void): void;
  /** Register a handler for transport close / child exit. */
  onClose(handler: () => void): void;
  /** Best-effort shutdown (closes the child's stdin). */
  close(): void;
}

/** One streamed `session/update` payload (the `update` field of the notification). */
export interface SessionUpdate {
  sessionUpdate: string;
  content?: { type: string; text?: string };
  toolCallId?: string;
  title?: string;
  status?: string;
  entries?: Array<{ content: string; status: string; priority?: string }>;
  [k: string]: unknown;
}

/** A permission option offered by the agent. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface PermissionRequest {
  sessionId: string;
  options: PermissionOption[];
}

/** Why a prompt finished. */
export type StopReason = 'end_turn' | 'cancelled' | string;

export interface AcpClientHandlers {
  /** A streamed session update (assistant text, tool call, plan, …). */
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  /**
   * The agent asks the human to approve a tool action. Resolve with the chosen
   * `optionId` (e.g. `'allow'` / `'reject'`), or `null` to decline. The default
   * (no handler) declines every request — the safe default.
   */
  onPermission?: (request: PermissionRequest) => Promise<string | null>;
  /** Diagnostic log line (protocol trace, transport errors). */
  onLog?: (message: string) => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(
    private readonly transport: AcpTransport,
    private readonly handlers: AcpClientHandlers = {},
  ) {
    this.transport.onLine((line) => this.receive(line));
    this.transport.onClose(() => this.onTransportClosed());
  }

  // ── public protocol surface ────────────────────────────────────────────────

  /** ACP handshake. Returns the agent's advertised capabilities. */
  async initialize(): Promise<{ protocolVersion: number; agentCapabilities?: unknown }> {
    const result = (await this.request('initialize', {})) as {
      protocolVersion: number;
      agentCapabilities?: unknown;
    };
    return result;
  }

  /** No-op auth on the Excalibur server, but part of the standard flow. */
  async authenticate(): Promise<void> {
    await this.request('authenticate', {});
  }

  /** Opens a new session rooted at `cwd`; returns its id. */
  async newSession(cwd: string): Promise<string> {
    const result = (await this.request('session/new', { cwd })) as { sessionId: string };
    return result.sessionId;
  }

  /**
   * Sends a prompt and resolves only when the whole run finishes (ACP semantics).
   * Updates stream via {@link AcpClientHandlers.onUpdate} meanwhile; permission
   * requests are answered via {@link AcpClientHandlers.onPermission}.
   */
  async prompt(sessionId: string, text: string): Promise<{ stopReason: StopReason }> {
    const result = (await this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })) as { stopReason: StopReason };
    return result;
  }

  /** Cancels the session's active run (a notification — no reply expected). */
  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  /** Tears down the client + transport, rejecting any in-flight requests. */
  dispose(): void {
    this.onTransportClosed();
    this.transport.close();
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AcpError(`cannot call "${method}": ACP transport is closed`));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: JsonRpcMessage): void {
    try {
      this.transport.send(JSON.stringify(message));
    } catch (error) {
      this.handlers.onLog?.(`ACP write failed: ${describe(error)}`);
    }
  }

  private receive(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.handlers.onLog?.(`ACP: ignoring non-JSON line: ${trimmed.slice(0, 200)}`);
      return;
    }
    // A response to one of our requests (has id + result/error, no method).
    if (message.id !== undefined && message.method === undefined) {
      this.resolveResponse(message);
      return;
    }
    // A server→client request (has id AND method) — only request_permission today.
    if (message.id !== undefined && message.method !== undefined) {
      void this.handleServerRequest(message);
      return;
    }
    // A notification (method, no id) — session/update.
    if (message.method !== undefined) {
      this.handleNotification(message);
    }
  }

  private resolveResponse(message: JsonRpcMessage): void {
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    if (message.error !== undefined) {
      pending.reject(new AcpError(message.error.message, message.error.code));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(message: JsonRpcMessage): void {
    if (message.method !== 'session/update') return;
    const params = message.params as { sessionId?: string; update?: SessionUpdate } | undefined;
    if (params?.update === undefined) return;
    this.handlers.onUpdate?.(params.sessionId ?? '', params.update);
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (message.method !== 'session/request_permission') {
      // Unknown server request → method-not-found, so the server never hangs.
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `method not found: ${message.method}` },
      });
      return;
    }
    const params = (message.params ?? {}) as PermissionRequest;
    let optionId: string | null = null;
    try {
      optionId = this.handlers.onPermission
        ? await this.handlers.onPermission({
            sessionId: params.sessionId ?? '',
            options: Array.isArray(params.options) ? params.options : [],
          })
        : null;
    } catch (error) {
      this.handlers.onLog?.(`ACP permission handler threw: ${describe(error)}`);
      optionId = null;
    }
    // Reply in the exact doubly-nested shape the server's isAllowOutcome expects.
    const outcome =
      optionId !== null
        ? { outcome: 'selected', optionId }
        : { outcome: 'selected', optionId: 'reject' };
    this.write({ jsonrpc: '2.0', id: message.id, result: { outcome } });
  }

  private onTransportClosed(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new AcpError('ACP transport closed');
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
