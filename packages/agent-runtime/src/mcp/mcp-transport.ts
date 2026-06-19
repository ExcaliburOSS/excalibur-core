import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { ProviderError } from '@excalibur/shared';
import type { JsonRpcNotification, JsonRpcRequest } from './mcp-client';

/**
 * MCP transports (OSS spec §17 + plan P1.11 "MCP remote"). The {@link McpClient}
 * speaks JSON-RPC 2.0 over a transport; this module provides the two real ones:
 *
 *  - {@link StdioTransport} — spawns a server subprocess and frames messages as
 *    newline-delimited JSON over its stdio (the original local transport).
 *  - {@link HttpTransport} — the modern **Streamable HTTP** remote transport: a
 *    single endpoint that the client POSTs each JSON-RPC message to; the server
 *    replies with `application/json` OR an `text/event-stream` (SSE) body. Auth
 *    is whatever headers the caller passes (e.g. `Authorization: Bearer …`), and
 *    the server-assigned `Mcp-Session-Id` is echoed on subsequent requests.
 *
 * A transport delivers parsed JSON-RPC messages to a handler and reports a
 * terminal close reason; the client owns request/response correlation + timeouts.
 */

/** A parsed JSON-RPC message handed up to the client (response or server msg). */
export type IncomingMessage = Record<string, unknown>;

export interface McpTransport {
  /** Registers the message + close handlers (called once, before any send). */
  attach(onMessage: (message: IncomingMessage) => void, onClose: (reason: Error) => void): void;
  /** Sends one JSON-RPC request/notification. May throw synchronously (stdio). */
  send(message: JsonRpcRequest | JsonRpcNotification): void;
  /** Tears the transport down (kill subprocess / abort in-flight requests). */
  close(): void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── stdio ────────────────────────────────────────────────────────────────────

export interface StdioTransportOptions {
  command: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Newline-delimited JSON-RPC over a spawned subprocess's stdio. */
export class StdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private onMessage: (message: IncomingMessage) => void = () => {};
  private onClose: (reason: Error) => void = () => {};
  private buffer = '';
  private closed = false;

  constructor(options: StdioTransportOptions) {
    if (options.command.trim().length === 0) {
      throw new ProviderError('MCP server command must not be empty.', {
        code: 'mcp_invalid_command',
      });
    }
    try {
      this.child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new ProviderError(
        `Could not start MCP server "${options.command}": ${describe(error)}.`,
        { code: 'mcp_spawn_failed', details: { command: options.command } },
      );
    }
  }

  attach(onMessage: (m: IncomingMessage) => void, onClose: (r: Error) => void): void {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.on('error', (error: Error) => {
      this.onClose(
        new ProviderError(`MCP server process error: ${error.message}.`, {
          code: 'mcp_process_error',
        }),
      );
    });
    this.child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.onClose(
        new ProviderError(
          `MCP server exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`,
          { code: 'mcp_process_exited', details: { exitCode: code, signal } },
        ),
      );
    });
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    const ok = this.child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!ok && this.child.stdin.destroyed) {
      throw new ProviderError('MCP server stdin is no longer writable.', {
        code: 'mcp_write_failed',
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdout.removeAllListeners('data');
    this.child.removeAllListeners('error');
    this.child.removeAllListeners('exit');
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          this.onMessage(JSON.parse(line) as IncomingMessage);
        } catch {
          // a stray non-JSON log line on stdout — tolerate it
        }
      }
      nl = this.buffer.indexOf('\n');
    }
  }
}

// ── Streamable HTTP (remote) ───────────────────────────────────────────────────

export interface HttpTransportOptions {
  /** The MCP server endpoint (Streamable HTTP — a single POST URL). */
  url: string;
  /** Extra request headers, e.g. `{ Authorization: 'Bearer …' }`. */
  headers?: Record<string, string>;
  /** Abort signal to cancel in-flight requests. */
  signal?: AbortSignal;
}

/** Splits an SSE body into the JSON payloads of its `data:` lines. */
function parseSseData(body: string): string[] {
  const payloads: string[] = [];
  for (const event of body.split(/\n\n+/)) {
    const data = event
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).trim())
      .join('');
    if (data.length > 0) payloads.push(data);
  }
  return payloads;
}

/**
 * The Streamable HTTP remote transport. Each JSON-RPC message is POSTed to the
 * endpoint; the response (JSON or SSE) is parsed and delivered to the client's
 * message handler. A network/HTTP error for a REQUEST is turned into a synthetic
 * JSON-RPC error response for that id, so the client's pending request settles
 * (rather than hanging until timeout). Notifications expect no response (202).
 */
export class HttpTransport implements McpTransport {
  private onMessage: (message: IncomingMessage) => void = () => {};
  private onClose: (reason: Error) => void = () => {};
  private sessionId: string | null = null;
  private readonly controller = new AbortController();
  private closed = false;

  constructor(private readonly options: HttpTransportOptions) {
    if (!/^https?:\/\//i.test(options.url)) {
      throw new ProviderError(`MCP http url must be http(s): "${options.url}".`, {
        code: 'mcp_invalid_command',
      });
    }
  }

  attach(onMessage: (m: IncomingMessage) => void, onClose: (r: Error) => void): void {
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    void this.post(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller.abort();
    } catch {
      /* nothing in flight */
    }
  }

  private async post(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const isRequest = 'id' in message && message.id !== undefined;
    const id = isRequest ? (message as JsonRpcRequest).id : null;
    try {
      const res = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId !== null ? { 'mcp-session-id': this.sessionId } : {}),
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(message),
        signal: this.options.signal ?? this.controller.signal,
      });
      const assigned = res.headers.get('mcp-session-id');
      if (assigned !== null && assigned.length > 0) {
        this.sessionId = assigned;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.deliverError(
          id,
          `HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`,
        );
        return;
      }
      if (!isRequest) {
        return; // a notification — no response body to correlate
      }
      const contentType = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const payloads = contentType.includes('text/event-stream') ? parseSseData(raw) : [raw];
      for (const payload of payloads) {
        if (payload.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(payload) as unknown;
          if (Array.isArray(parsed)) {
            for (const m of parsed) this.onMessage(m as IncomingMessage);
          } else {
            this.onMessage(parsed as IncomingMessage);
          }
        } catch {
          this.deliverError(id, 'MCP server returned a non-JSON response body.');
          return;
        }
      }
    } catch (error) {
      if (this.closed) return; // aborted on close — the client is already tearing down
      this.deliverError(id, describe(error));
    }
  }

  /** Delivers a synthetic JSON-RPC error response so the pending request settles. */
  private deliverError(id: string | number | null, message: string): void {
    if (id === null) {
      // A notification has no id to correlate, so a failed notification POST is
      // simply DROPPED (MCP notifications are fire-and-forget). It is not
      // deferred; a real problem surfaces on the next request that does have an id.
      return;
    }
    this.onMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }
}
