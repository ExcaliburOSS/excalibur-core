import type { ExcaliburEvent } from '@excalibur/shared';
import type { RunHandle } from '@excalibur/core';

/**
 * ACP (Agent Client Protocol) server (P0.3c) — a JSON-RPC 2.0 server over stdio
 * that an external editor (Zed, JetBrains, Neovim, …) spawns to drive Excalibur.
 *
 * Wire format: newline-delimited JSON-RPC 2.0 (one message per line). The editor
 * is the CLIENT (it spawns us); we are the AGENT. We implement the core methods —
 * `initialize`, `session/new`, `session/prompt`, `session/cancel` — and stream the
 * run's `ExcaliburEvent`s back as `session/update` notifications (assistant text,
 * tool calls, the live plan). When the run needs a human decision we send the
 * client a `session/request_permission` request and gate the run on its answer.
 *
 * Run execution is injected via `startRun` (the command wires a `RunController`),
 * so this module stays decoupled + unit-testable with in-memory streams.
 */

/** The ACP protocol version this agent speaks. */
export const ACP_PROTOCOL_VERSION = 1;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface AcpServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Starts a run for a session prompt and returns its live handle. */
  startRun: (input: { cwd: string; prompt: string }) => Promise<RunHandle>;
  /** Working directory for sessions that don't specify one. */
  defaultCwd?: string;
}

interface AcpSession {
  cwd: string;
  active: RunHandle | null;
}

/** Joins the text blocks of an ACP prompt (`[{ type:'text', text }]`) into a string. */
function extractPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) {
    return typeof prompt === 'string' ? prompt : '';
  }
  return prompt
    .map((block) => {
      if (typeof block === 'object' && block !== null) {
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
      }
      return '';
    })
    .filter((t) => t.length > 0)
    .join('\n');
}

/** Maps an Excalibur event to an ACP `session/update` payload, or null to drop it. */
function toSessionUpdate(event: ExcaliburEvent): Record<string, unknown> | null {
  const payload = event.payload;
  switch (event.type) {
    case 'assistant_message':
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: String(payload['content'] ?? '') },
      };
    case 'tool_call': {
      const toolId = String(payload['tool'] ?? payload['name'] ?? 'tool');
      // The native loop emits an announce (with arguments) then a result (with `ok`).
      if ('ok' in payload) {
        return {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolId,
          status: payload['ok'] === false ? 'failed' : 'completed',
        };
      }
      return {
        sessionUpdate: 'tool_call',
        toolCallId: toolId,
        title: toolId,
        status: 'in_progress',
      };
    }
    case 'task_update': {
      const tasks = Array.isArray(payload['tasks']) ? (payload['tasks'] as unknown[]) : [];
      return {
        sessionUpdate: 'plan',
        entries: tasks.map((item) => {
          const t = (item ?? {}) as { text?: unknown; status?: unknown };
          return {
            content: typeof t.text === 'string' ? t.text : '',
            status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
            priority: 'medium',
          };
        }),
      };
    }
    // P1.5b — richer session view: stream the agent's edits, commands and
    // diagnostics so the webview can render a diff / command / problem count, not
    // just messages + tool names. These are Excalibur-namespaced kinds the
    // (Excalibur) ACP client understands; a generic ACP client ignores them.
    case 'file_write': {
      const path = typeof payload['path'] === 'string' ? payload['path'] : '';
      if (path.length === 0) return null;
      const diff = typeof payload['diff'] === 'string' ? payload['diff'] : '';
      return { sessionUpdate: 'excalibur/file', path, diff };
    }
    case 'command_started': {
      const command = typeof payload['command'] === 'string' ? payload['command'] : '';
      return command.length > 0
        ? { sessionUpdate: 'excalibur/command', command, exitCode: null }
        : null;
    }
    case 'command_completed': {
      const command = typeof payload['command'] === 'string' ? payload['command'] : '';
      if (command.length === 0) return null;
      const exitCode = typeof payload['exitCode'] === 'number' ? payload['exitCode'] : null;
      return { sessionUpdate: 'excalibur/command', command, exitCode };
    }
    case 'diagnostics': {
      const items = Array.isArray(payload['items']) ? (payload['items'] as unknown[]) : [];
      return { sessionUpdate: 'excalibur/diagnostics', count: items.length };
    }
    default:
      return null;
  }
}

/** A running ACP server instance. */
export class AcpServer {
  private readonly sessions = new Map<string, AcpSession>();
  private readonly pendingOut = new Map<number, (result: unknown) => void>();
  private sessionCounter = 0;
  private outCounter = 0;
  private lineBuffer = '';

  constructor(private readonly options: AcpServerOptions) {}

  /** Starts reading the input stream. Resolves when the stream ends. */
  start(): void {
    this.options.input.setEncoding?.('utf8');
    this.options.input.on('data', (chunk: string | Buffer) => {
      this.lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = this.lineBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.lineBuffer.slice(0, nl).trim();
        this.lineBuffer = this.lineBuffer.slice(nl + 1);
        if (line.length > 0) {
          void this.handleLine(line);
        }
        nl = this.lineBuffer.indexOf('\n');
      }
    });
  }

  private write(message: JsonRpcMessage): void {
    this.options.output.write(`${JSON.stringify(message)}\n`);
  }

  private reply(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private replyError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private async handleLine(line: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // ignore a malformed line
    }
    if (typeof message !== 'object' || message === null) return;

    if (typeof message.method === 'string') {
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (message.id !== undefined && message.id !== null) {
        await this.handleRequest(message.id, message.method, params);
      } else {
        this.handleNotification(message.method, params);
      }
      return;
    }
    // A response to one of our outgoing requests (e.g. request_permission).
    if (message.id !== undefined && message.id !== null && typeof message.id === 'number') {
      const resolve = this.pendingOut.get(message.id);
      if (resolve !== undefined) {
        this.pendingOut.delete(message.id);
        resolve(message.result);
      }
    }
  }

  private async handleRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    try {
      switch (method) {
        case 'initialize':
          this.reply(id, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
          });
          return;
        case 'authenticate':
          this.reply(id, {});
          return;
        case 'session/new': {
          const sessionId = `sess_acp_${(this.sessionCounter += 1)}`;
          const cwd =
            typeof params['cwd'] === 'string'
              ? params['cwd']
              : (this.options.defaultCwd ?? process.cwd());
          this.sessions.set(sessionId, { cwd, active: null });
          this.reply(id, { sessionId });
          return;
        }
        case 'session/prompt':
          await this.handlePrompt(id, params);
          return;
        default:
          this.replyError(id, -32601, `method not found: ${method}`);
      }
    } catch (error) {
      this.replyError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'session/cancel') {
      const session = this.sessions.get(String(params['sessionId'] ?? ''));
      session?.active?.cancel();
    }
  }

  private async handlePrompt(id: number | string, params: Record<string, unknown>): Promise<void> {
    const sessionId = String(params['sessionId'] ?? '');
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.replyError(id, -32602, `unknown session "${sessionId}"`);
      return;
    }
    const prompt = extractPromptText(params['prompt']);
    if (prompt.length === 0) {
      this.replyError(id, -32602, 'empty prompt');
      return;
    }

    const handle = await this.options.startRun({ cwd: session.cwd, prompt });
    session.active = handle;
    const unsubscribe = handle.subscribe((event) => {
      if (event.type === 'approval_requested') {
        const q = event.payload['question'];
        void this.requestPermission(sessionId, handle, typeof q === 'string' ? q : undefined);
        return;
      }
      const update = toSessionUpdate(event);
      if (update !== null) {
        this.notify('session/update', { sessionId, update });
      }
    });

    let cancelled = false;
    try {
      const record = await handle.record;
      cancelled = record.status === 'cancelled';
    } catch {
      cancelled = false;
    } finally {
      unsubscribe();
      session.active = null;
    }
    this.reply(id, { stopReason: cancelled ? 'cancelled' : 'end_turn' });
  }

  /** Asks the client to approve the run's pending action, then answers the run.
   * P1.5b: forwards the run's `question` so the client modal shows WHAT it is
   * approving instead of a generic "wants to run a tool action". */
  private async requestPermission(
    sessionId: string,
    handle: RunHandle,
    question?: string,
  ): Promise<void> {
    const id = (this.outCounter += 1);
    const result = await new Promise<unknown>((resolve) => {
      this.pendingOut.set(id, resolve);
      this.write({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          ...(question !== undefined ? { question } : {}),
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
    });
    handle.approve(isAllowOutcome(result));
  }
}

/** True when a request_permission response selected an allow option. */
function isAllowOutcome(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const outcome = (result as { outcome?: unknown }).outcome;
  if (typeof outcome !== 'object' || outcome === null) return false;
  const o = outcome as { outcome?: unknown; optionId?: unknown };
  return o.outcome === 'selected' && o.optionId === 'allow';
}

/** Convenience: build + start an ACP server. */
export function runAcpServer(options: AcpServerOptions): AcpServer {
  const server = new AcpServer(options);
  server.start();
  return server;
}
