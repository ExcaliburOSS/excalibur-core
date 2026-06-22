import { describe, expect, it, vi } from 'vitest';
import { AcpClient, AcpError, type AcpTransport } from './acp-client';

/** A fake ndjson transport: records sent frames, lets the test inject inbound lines. */
class FakeTransport implements AcpTransport {
  readonly sent: string[] = [];
  private lineHandler: (line: string) => void = () => {};
  private closeHandler: () => void = () => {};
  closed = false;

  send(message: string): void {
    this.sent.push(message);
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closed = true;
  }

  /** Test helper: deliver a server→client message. */
  emit(obj: unknown): void {
    this.lineHandler(JSON.stringify(obj));
  }
  emitRaw(line: string): void {
    this.lineHandler(line);
  }
  fireClose(): void {
    this.closeHandler();
  }
  /** The last sent frame, parsed. */
  last(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1] ?? '{}') as Record<string, unknown>;
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('AcpClient — request/response', () => {
  it('initialize sends the method and resolves with capabilities', async () => {
    const t = new FakeTransport();
    const client = new AcpClient(t);
    const p = client.initialize();
    const req = t.last();
    expect(req.method).toBe('initialize');
    expect(req.jsonrpc).toBe('2.0');
    t.emit({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    await expect(p).resolves.toEqual({ protocolVersion: 1, agentCapabilities: {} });
  });

  it('newSession sends cwd and returns the sessionId', async () => {
    const t = new FakeTransport();
    const client = new AcpClient(t);
    const p = client.newSession('/repo');
    const req = t.last();
    expect(req.method).toBe('session/new');
    expect(req.params).toEqual({ cwd: '/repo' });
    t.emit({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'sess_acp_1' } });
    await expect(p).resolves.toBe('sess_acp_1');
  });

  it('a JSON-RPC error rejects the request as an AcpError', async () => {
    const t = new FakeTransport();
    const client = new AcpClient(t);
    const p = client.newSession('/repo');
    const req = t.last();
    t.emit({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'bad cwd' } });
    await expect(p).rejects.toBeInstanceOf(AcpError);
    await expect(p).rejects.toThrow(/bad cwd/);
  });
});

describe('AcpClient — prompt streaming', () => {
  it('passes the prompt as a text block, streams updates, resolves on stopReason', async () => {
    const updates: Array<{ sessionId: string; kind: string }> = [];
    const t = new FakeTransport();
    const client = new AcpClient(t, {
      onUpdate: (sessionId, update) => updates.push({ sessionId, kind: update.sessionUpdate }),
    });
    const p = client.prompt('s1', 'do the thing');
    const req = t.last();
    expect(req.method).toBe('session/prompt');
    expect(req.params).toEqual({ sessionId: 's1', prompt: [{ type: 'text', text: 'do the thing' }] });

    // Stream a couple of notifications (no id) before the response.
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'read_file' } },
    });
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      },
    });
    t.emit({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } });

    await expect(p).resolves.toEqual({ stopReason: 'end_turn' });
    expect(updates).toEqual([
      { sessionId: 's1', kind: 'tool_call' },
      { sessionId: 's1', kind: 'agent_message_chunk' },
    ]);
  });

  it('cancel sends a session/cancel notification (no id)', () => {
    const t = new FakeTransport();
    const client = new AcpClient(t);
    client.cancel('s1');
    const msg = t.last();
    expect(msg.method).toBe('session/cancel');
    expect(msg.params).toEqual({ sessionId: 's1' });
    expect(msg.id).toBeUndefined();
  });
});

describe('AcpClient — permission requests (server → client)', () => {
  it('answers request_permission with the chosen optionId in the doubly-nested shape', async () => {
    const t = new FakeTransport();
    new AcpClient(t, {
      onPermission: () => Promise.resolve('allow'),
    });
    t.emit({
      jsonrpc: '2.0',
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 's1',
        options: [
          { optionId: 'allow', name: 'Allow' },
          { optionId: 'reject', name: 'Reject' },
        ],
      },
    });
    await flush();
    const reply = t.last();
    expect(reply.id).toBe(42);
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('declines (optionId reject) when there is no permission handler', async () => {
    const t = new FakeTransport();
    new AcpClient(t); // no onPermission
    t.emit({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: { sessionId: 's1', options: [{ optionId: 'allow', name: 'Allow' }] },
    });
    await flush();
    const reply = t.last();
    expect(reply.id).toBe(7);
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
  });

  it('responds method-not-found to an unknown server request (never hangs the server)', async () => {
    const t = new FakeTransport();
    new AcpClient(t);
    t.emit({ jsonrpc: '2.0', id: 5, method: 'fs/read_text_file', params: {} });
    await flush();
    const reply = t.last();
    expect(reply.id).toBe(5);
    expect((reply.error as { code: number }).code).toBe(-32601);
  });
});

describe('AcpClient — robustness', () => {
  it('ignores malformed lines and logs them, without throwing', () => {
    const onLog = vi.fn();
    const t = new FakeTransport();
    new AcpClient(t, { onLog });
    expect(() => t.emitRaw('not json {{{')).not.toThrow();
    expect(onLog).toHaveBeenCalled();
  });

  it('settles (rejects) a request on a malformed error response — never hangs', async () => {
    const t = new FakeTransport();
    const client = new AcpClient(t);
    const p = client.newSession('/repo');
    const req = t.last();
    // A non-conforming peer sends `error: null` — must NOT be dereferenced and
    // must still settle the request (regression: used to throw + hang forever).
    t.emit({ jsonrpc: '2.0', id: req.id, error: null });
    await expect(p).rejects.toThrow(/missing both result and a valid error|ACP/);
  });

  it('rejects gracefully on a non-object error payload', async () => {
    const t = new FakeTransport();
    const client = new AcpClient(t);
    const p = client.newSession('/repo');
    const req = t.last();
    t.emit({ jsonrpc: '2.0', id: req.id, error: 'oops' });
    await expect(p).rejects.toThrow();
  });

  it('a throwing onUpdate handler never breaks the read loop', async () => {
    const t = new FakeTransport();
    const client = new AcpClient(t, {
      onUpdate: () => {
        throw new Error('boom');
      },
      onLog: () => {},
    });
    const p = client.prompt('s1', 'go');
    const req = t.last();
    // This update makes onUpdate throw — it must be contained...
    t.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } },
    });
    // ...so the very next message (the prompt response) is still processed.
    t.emit({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } });
    await expect(p).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('rejects in-flight requests when the transport closes', async () => {
    const t = new FakeTransport();
    const client = new AcpClient(t);
    const p = client.newSession('/repo');
    t.fireClose();
    await expect(p).rejects.toThrow(/transport closed/);
    // Subsequent calls fail fast too.
    await expect(client.initialize()).rejects.toThrow(/closed/);
  });
});
