import { ProviderError } from '@excalibur/shared';
import {
  HttpTransport,
  StdioTransport,
  type HttpTransportOptions,
  type IncomingMessage,
  type McpTransport,
} from './mcp-transport';

/**
 * Minimal Model Context Protocol (MCP) client (OSS spec §17 + plan P1.11).
 *
 * Speaks JSON-RPC 2.0 over a pluggable {@link McpTransport} — local
 * {@link StdioTransport} (spawned subprocess) or remote {@link HttpTransport}
 * (Streamable HTTP). It performs the `initialize` handshake, then exposes
 * `listTools()` (`tools/list`) and `callTool()` (`tools/call`) and a `close()`.
 *
 * ## Framing assumption
 *
 * The MCP stdio transport frames messages as **newline-delimited JSON** — each
 * JSON-RPC message is a single line of UTF-8 terminated by `\n`, and an
 * individual message MUST NOT contain an embedded newline. This client
 * implements that (simpler) line-delimited framing. It does **not** implement
 * HTTP-style `Content-Length` framing; servers that emit `Content-Length`
 * headers on the stdio transport are not supported. In practice the reference
 * MCP servers and SDKs use line-delimited JSON over stdio, so this is the
 * correct default.
 *
 * ## Robustness
 *
 * - The child is spawned with `shell: false` (an args array) so a tool name or
 *   argument can never inject a shell command.
 * - Every request is bounded by a timeout; a timed-out, rejected, or crashed
 *   request never leaves a dangling promise.
 * - The child is killed (and its stdio detached) on `close()`, on a spawn
 *   error, and if the process exits while requests are in flight — the client
 *   never leaks the subprocess.
 * - All failures surface as a {@link ProviderError} with a stable, narrowed
 *   `code` (`mcp_*`) so callers can branch without string-matching messages.
 */

/** JSON value — the wire type for JSON-RPC params, results and tool arguments. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object (the shape of tool arguments and most result payloads). */
export type JsonObject = { [key: string]: JsonValue };

/** JSON-RPC 2.0 request id — a string or number per the spec (never null for requests). */
export type JsonRpcId = string | number;

/** A JSON-RPC 2.0 request envelope (a method call that expects a response). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
}

/** A JSON-RPC 2.0 notification envelope (a method call with no response). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: JsonObject;
}

/** The `error` member of a JSON-RPC 2.0 error response. */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: JsonValue;
}

/** A JSON-RPC 2.0 response envelope — exactly one of `result` / `error` is set. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: JsonValue;
  error?: JsonRpcError;
}

/** Behavior hints an MCP server may attach to a tool (MCP spec `annotations`). */
export interface McpToolAnnotations {
  /** The tool does not modify its environment (safe to expose to read-only roles). */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates. */
  destructiveHint?: boolean;
  [key: string]: JsonValue | undefined;
}

/** A tool descriptor as returned by an MCP server's `tools/list` (MCP spec). */
export interface McpTool {
  /** Unique tool name, used as the `name` argument to {@link McpClient.callTool}. */
  name: string;
  /** Optional human-readable description of what the tool does. */
  description?: string;
  /** JSON Schema (draft 2020-12) describing the tool's `arguments` object. */
  inputSchema: JsonObject;
  /** Optional behavior hints (read-only / destructive) used for role gating (F6). */
  annotations?: McpToolAnnotations;
}

/** A single content block of a `tools/call` result (text / image / resource). */
export interface McpContentBlock {
  type: string;
  /** Present on `type: "text"` blocks. */
  text?: string;
  /** Additional, type-specific fields (e.g. `data`/`mimeType` for images). */
  [key: string]: JsonValue | undefined;
}

/** The result of a `tools/call` invocation (MCP spec). */
export interface McpToolResult {
  /** Ordered content blocks the tool produced. */
  content: McpContentBlock[];
  /**
   * `true` when the tool itself reported an error (a tool-level failure the
   * model should see), as opposed to a protocol/transport error which throws.
   */
  isError: boolean;
}

/** Server identity + capabilities returned by the `initialize` handshake. */
export interface McpServerInfo {
  /** Protocol version the server agreed to speak. */
  protocolVersion: string;
  /** Server-declared capabilities (e.g. `{ tools: {} }`). */
  capabilities: JsonObject;
  /** Server name + version, when provided. */
  serverInfo?: { name?: string; version?: string };
}

/** Options for spawning and driving an MCP server subprocess. */
export interface McpClientOptions {
  /** Executable to run (bare name resolved on PATH, or an absolute path). No shell is used. */
  command: string;
  /** Arguments passed to the executable (never shell-interpreted). */
  args?: ReadonlyArray<string>;
  /** Working directory for the subprocess (defaults to the parent's cwd). */
  cwd?: string;
  /**
   * Environment for the subprocess. Defaults to inheriting `process.env` so the
   * server uses its own configured auth/paths. Pass an explicit object to lock
   * it down.
   */
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout in milliseconds (default {@link DEFAULT_MCP_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * Timeout for the one-time `initialize` handshake (default
   * {@link DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS}). Separate from {@link timeoutMs}
   * so a short per-request budget doesn't flake on slow subprocess cold-start.
   */
  handshakeTimeoutMs?: number;
  /**
   * Client identity advertised in the `initialize` handshake (default
   * {@link DEFAULT_CLIENT_INFO}).
   */
  clientInfo?: { name: string; version: string };
  /** MCP protocol version to request (default {@link MCP_PROTOCOL_VERSION}). */
  protocolVersion?: string;
}

/** Options for connecting to a REMOTE MCP server over Streamable HTTP. */
export interface McpHttpClientOptions {
  /** The MCP server endpoint URL (http/https). */
  url: string;
  /** Extra request headers, e.g. `{ Authorization: 'Bearer <token>' }` for OAuth. */
  headers?: Record<string, string>;
  /** Abort signal to cancel in-flight requests. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds (default {@link DEFAULT_MCP_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * Timeout for the one-time `initialize` handshake (default
   * {@link DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS}). Separate from {@link timeoutMs}
   * so a short per-request budget doesn't flake on slow connection setup.
   */
  handshakeTimeoutMs?: number;
  /** Client identity advertised in `initialize` (default {@link DEFAULT_CLIENT_INFO}). */
  clientInfo?: { name: string; version: string };
  /** MCP protocol version to request (default {@link MCP_PROTOCOL_VERSION}). */
  protocolVersion?: string;
}

/** Default per-request timeout (30s) — long enough for a slow tool, short enough to fail fast. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/**
 * Default timeout for the one-time `initialize` handshake (60s). The handshake
 * covers subprocess/connection cold-start (spawn, runtime warm-up, first I/O),
 * which can be far slower than a steady-state request — especially when many
 * servers start at once — so it gets its own, more generous budget independent
 * of the per-request {@link DEFAULT_MCP_TIMEOUT_MS}.
 */
export const DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * MCP protocol version this client requests in `initialize`. A compliant server
 * either echoes this back or replies with a version it does support; this
 * client accepts whatever the server returns and records it on
 * {@link McpServerInfo}. (`2025-03-26` is the prior version many servers also
 * accept.)
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Identity this client advertises by default in the handshake. */
export const DEFAULT_CLIENT_INFO = { name: 'excalibur-agent-runtime', version: '0.1.0' } as const;

/** A pending request awaiting its response, keyed by JSON-RPC id. */
interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * A foundational MCP client speaking line-delimited JSON-RPC 2.0 over a
 * subprocess's stdio. Construct with {@link McpClient.connect}, then call
 * {@link McpClient.listTools} / {@link McpClient.callTool}, and always
 * {@link McpClient.close} when done.
 */
export class McpClient {
  private readonly transport: McpTransport;
  private readonly timeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  /** Set once the client is closed or the transport has died — every later call rejects. */
  private closedReason: Error | null = null;
  private serverInfo: McpServerInfo | null = null;

  private constructor(transport: McpTransport, timeoutMs: number) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.transport.attach(
      (message) => this.handleMessage(message),
      (reason) => {
        if (this.closedReason === null) this.destroy(reason);
      },
    );
  }

  /**
   * Spawns a LOCAL MCP server (stdio) and completes the `initialize` handshake.
   * The subprocess is always cleaned up on failure — this never leaks a process.
   *
   * @throws ProviderError (`mcp_spawn_failed`) if the executable cannot start.
   * @throws ProviderError (`mcp_*`) if the handshake fails or times out.
   */
  static async connect(options: McpClientOptions): Promise<McpClient> {
    const transport = new StdioTransport({
      command: options.command,
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    return McpClient.handshake(
      transport,
      options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      options.handshakeTimeoutMs ?? DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS,
      options,
    );
  }

  /**
   * Connects to a REMOTE MCP server over Streamable HTTP (plan P1.11) and
   * completes the `initialize` handshake. Auth is whatever headers are passed
   * (e.g. an OAuth `Authorization: Bearer …`); the session id is handled by the
   * transport. The connection is torn down on a failed handshake.
   */
  static async connectHttp(options: McpHttpClientOptions): Promise<McpClient> {
    const transport = new HttpTransport({
      url: options.url,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    } as HttpTransportOptions);
    return McpClient.handshake(
      transport,
      options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      options.handshakeTimeoutMs ?? DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS,
      options,
    );
  }

  /** Shared `initialize` handshake over any transport. */
  private static async handshake(
    transport: McpTransport,
    timeoutMs: number,
    handshakeTimeoutMs: number,
    options: { clientInfo?: { name: string; version: string }; protocolVersion?: string },
  ): Promise<McpClient> {
    const client = new McpClient(transport, timeoutMs);
    try {
      const initResult = await client.request(
        'initialize',
        {
          protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: options.clientInfo ?? { ...DEFAULT_CLIENT_INFO },
        },
        handshakeTimeoutMs,
      );
      client.serverInfo = parseServerInfo(initResult);
      client.notify('notifications/initialized');
    } catch (error) {
      client.destroy(error instanceof Error ? error : new Error(describe(error)));
      throw error;
    }
    return client;
  }

  /** Server identity + capabilities negotiated during the handshake. */
  getServerInfo(): McpServerInfo {
    if (this.serverInfo === null) {
      throw new ProviderError('MCP handshake has not completed.', { code: 'mcp_not_initialized' });
    }
    return this.serverInfo;
  }

  /**
   * Lists the tools the server exposes (`tools/list`). Does not follow
   * pagination cursors — returns the first page (sufficient for the
   * foundational client; cursor support is a follow-up).
   *
   * @throws ProviderError (`mcp_*`) on a protocol error, timeout, or malformed result.
   */
  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {});
    if (!isObject(result) || !Array.isArray(result.tools)) {
      throw new ProviderError('MCP tools/list returned a malformed result.', {
        code: 'mcp_protocol_error',
      });
    }
    return result.tools.map(parseTool);
  }

  /**
   * Invokes a tool by name with the given arguments (`tools/call`). A
   * tool-level failure is returned as a result with `isError: true` (so the
   * model can react to it); a protocol/transport failure throws.
   *
   * @param name Tool name as returned by {@link listTools}.
   * @param args Arguments matching the tool's `inputSchema` (default `{}`).
   * @throws ProviderError (`mcp_*`) on a protocol error, timeout, or malformed result.
   */
  async callTool(name: string, args: JsonObject = {}): Promise<McpToolResult> {
    if (name.trim().length === 0) {
      throw new ProviderError('MCP tool name must not be empty.', { code: 'mcp_invalid_tool' });
    }
    const result = await this.request('tools/call', { name, arguments: args });
    if (!isObject(result)) {
      throw new ProviderError(`MCP tools/call("${name}") returned a malformed result.`, {
        code: 'mcp_protocol_error',
        details: { tool: name },
      });
    }
    const content = Array.isArray(result.content) ? result.content.map(parseContentBlock) : [];
    return { content, isError: result.isError === true };
  }

  /**
   * Shuts the client down: rejects all in-flight requests, removes listeners and
   * terminates the subprocess. Idempotent and safe to call from a `finally`.
   */
  close(): void {
    this.destroy(new ProviderError('MCP client closed.', { code: 'mcp_closed' }));
  }

  /**
   * Sends a request and resolves with its JSON-RPC `result` (or rejects on
   * error/timeout). `timeoutMs` overrides the client-wide budget for this one
   * call (used to give the `initialize` handshake a more generous deadline).
   */
  private request(
    method: string,
    params: JsonObject,
    timeoutMs: number = this.timeoutMs,
  ): Promise<JsonValue> {
    if (this.closedReason !== null) {
      return Promise.reject(this.closedReason);
    }
    const id = this.nextId++;
    const envelope: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProviderError(`MCP request "${method}" timed out after ${timeoutMs}ms.`, {
            code: 'mcp_timeout',
            details: { method },
          }),
        );
      }, timeoutMs);
      // Don't let a pending request keep the event loop alive.
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer, method });

      try {
        this.write(envelope);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new ProviderError(`Failed to send MCP request "${method}": ${describe(error)}.`, {
                code: 'mcp_write_failed',
                details: { method },
              }),
        );
      }
    });
  }

  /** Fire-and-forget a JSON-RPC notification (no id, no response). */
  private notify(method: string, params?: JsonObject): void {
    const envelope: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    try {
      this.write(envelope);
    } catch {
      // A notification is best-effort; a write failure surfaces on the next request.
    }
  }

  /** Sends a message through the active transport (may throw synchronously on stdio). */
  private write(message: JsonRpcRequest | JsonRpcNotification): void {
    if (this.closedReason !== null) {
      throw this.closedReason;
    }
    this.transport.send(message);
  }

  /** Settles the matching pending request for a parsed JSON-RPC message. */
  private handleMessage(message: IncomingMessage): void {
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      return;
    }
    // Responses carry an `id`; notifications/requests from the server don't and
    // are ignored by this foundational client.
    if (!('id' in message) || message.id === null || message.id === undefined) {
      return;
    }
    const id = message.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (isObject(message.error)) {
      const err = message.error as unknown as JsonRpcError;
      pending.reject(
        new ProviderError(`MCP "${pending.method}" failed: ${err.message} (code ${err.code}).`, {
          code: 'mcp_rpc_error',
          details: { method: pending.method, rpcCode: err.code },
        }),
      );
      return;
    }
    pending.resolve((message.result ?? null) as JsonValue);
  }

  /**
   * Tears down the client exactly once: records the reason, rejects every
   * pending request, detaches listeners, and kills the subprocess. All later
   * calls reject with `reason`.
   */
  private destroy(reason: Error): void {
    if (this.closedReason !== null) {
      return;
    }
    this.closedReason = reason;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();

    try {
      this.transport.close();
    } catch {
      /* transport already torn down */
    }
  }
}

/** Narrows an unknown value to a plain object (for safe field access). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extracts a readable message from an unknown thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parses and validates the `initialize` result into {@link McpServerInfo}. */
function parseServerInfo(result: JsonValue): McpServerInfo {
  if (!isObject(result) || typeof result.protocolVersion !== 'string') {
    throw new ProviderError('MCP initialize returned a malformed result.', {
      code: 'mcp_protocol_error',
    });
  }
  const capabilities = isObject(result.capabilities) ? (result.capabilities as JsonObject) : {};
  const info: McpServerInfo = {
    protocolVersion: result.protocolVersion,
    capabilities,
  };
  if (isObject(result.serverInfo)) {
    const raw = result.serverInfo;
    const serverInfo: { name?: string; version?: string } = {
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
    };
    info.serverInfo = serverInfo;
  }
  return info;
}

/** Parses one entry of a `tools/list` result into a typed {@link McpTool}. */
function parseTool(raw: JsonValue): McpTool {
  if (!isObject(raw) || typeof raw.name !== 'string') {
    throw new ProviderError('MCP tools/list returned a tool without a name.', {
      code: 'mcp_protocol_error',
    });
  }
  const inputSchema = isObject(raw.inputSchema) ? (raw.inputSchema as JsonObject) : {};
  return {
    name: raw.name,
    inputSchema,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(isObject(raw.annotations) ? { annotations: raw.annotations as McpToolAnnotations } : {}),
  };
}

/** Coerces one `tools/call` content entry into a typed {@link McpContentBlock}. */
function parseContentBlock(raw: JsonValue): McpContentBlock {
  if (!isObject(raw) || typeof raw.type !== 'string') {
    return { type: 'unknown' };
  }
  return raw as unknown as McpContentBlock;
}
