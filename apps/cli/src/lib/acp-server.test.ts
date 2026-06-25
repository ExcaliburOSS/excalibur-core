import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createEvent, type ExcaliburEvent, type RunRecord } from '@excalibur/shared';
import type { RunHandle } from '@excalibur/core';
import { ACP_PROTOCOL_VERSION, runAcpServer } from './acp-server';

interface RpcMsg {
  id?: number | string | null;
  method?: string;
  result?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

/** A controllable fake run: emits a scripted event sequence on subscribe. */
function fakeHandle(script: (emit: (e: ExcaliburEvent) => void, finish: () => void) => void): {
  handle: RunHandle;
  approvals: boolean[];
  cancels: { n: number };
} {
  const approvals: boolean[] = [];
  const cancels = { n: 0 };
  let resolveRecord!: (r: RunRecord) => void;
  const record = new Promise<RunRecord>((resolve) => {
    resolveRecord = resolve;
  });
  const ev = (type: ExcaliburEvent['type'], payload: Record<string, unknown>): ExcaliburEvent =>
    createEvent({ runId: 'run_20260101_000000', type, payload });
  const handle: RunHandle = {
    runId: 'run_20260101_000000',
    workflowId: 'fast-fix',
    record,
    status: () => 'running',
    events: () => [],
    subscribe: (listener) => {
      setImmediate(() =>
        script(
          (e) => listener(e),
          () => resolveRecord({ status: 'completed' } as RunRecord),
        ),
      );
      return () => undefined;
    },
    pendingApproval: () => null,
    approve: (decision) => approvals.push(decision),
    cancel: () => {
      cancels.n += 1;
      resolveRecord({ status: 'cancelled' } as RunRecord);
    },
  };
  // expose ev for scripts via closure
  (handle as unknown as { ev: typeof ev }).ev = ev;
  return { handle, approvals, cancels };
}

function setup(startRun: (input: { cwd: string; prompt: string }) => Promise<RunHandle>): {
  send: (msg: Record<string, unknown>) => void;
  waitFor: (pred: (m: RpcMsg) => boolean) => Promise<RpcMsg>;
} {
  const input = new PassThrough();
  const out: RpcMsg[] = [];
  const waiters: Array<{ pred: (m: RpcMsg) => boolean; resolve: (m: RpcMsg) => void }> = [];
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        const m = JSON.parse(line) as RpcMsg;
        out.push(m);
        for (const w of [...waiters]) {
          if (w.pred(m)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(m);
          }
        }
      }
      cb();
    },
  });
  runAcpServer({ input, output, startRun, defaultCwd: '/tmp' });
  return {
    send: (msg) => input.write(`${JSON.stringify(msg)}\n`),
    waitFor: (pred) =>
      new Promise<RpcMsg>((resolve) => {
        const existing = out.find(pred);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        waiters.push({ pred, resolve });
      }),
  };
}

const ev = (type: ExcaliburEvent['type'], payload: Record<string, unknown>): ExcaliburEvent =>
  createEvent({ runId: 'run_20260101_000000', type, payload });

describe('ACP server', () => {
  it('responds to initialize with the protocol version + capabilities', async () => {
    const { send, waitFor } = setup(() => Promise.reject(new Error('no run')));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const reply = await waitFor((m) => m.id === 1);
    expect(reply.result?.['protocolVersion']).toBe(ACP_PROTOCOL_VERSION);
    expect(reply.result?.['agentCapabilities']).toBeDefined();
  });

  it('creates a session', async () => {
    const { send, waitFor } = setup(() => Promise.reject(new Error('no run')));
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/repo' } });
    const reply = await waitFor((m) => m.id === 2);
    expect(typeof reply.result?.['sessionId']).toBe('string');
  });

  it('runs a prompt: streams session/update + replies end_turn', async () => {
    const { handle } = fakeHandle((emit, finish) => {
      emit(ev('assistant_message', { content: 'Working on it' }));
      emit(ev('tool_call', { tool: 'read_file' }));
      emit(ev('task_update', { tasks: [{ text: 'step', status: 'completed' }] }));
      finish();
    });
    const { send, waitFor } = setup(() => Promise.resolve(handle));

    send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/repo' } });
    const created = await waitFor((m) => m.id === 3);
    const sessionId = created.result?.['sessionId'];

    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'do it' }] },
    });

    const msg = await waitFor(
      (m) =>
        m.method === 'session/update' &&
        (m.params?.['update'] as { sessionUpdate?: string } | undefined)?.sessionUpdate ===
          'agent_message_chunk',
    );
    expect((msg.params?.['update'] as { content?: { text?: string } }).content?.text).toBe(
      'Working on it',
    );

    const done = await waitFor((m) => m.id === 4);
    expect(done.result?.['stopReason']).toBe('end_turn');
  });

  it('maps file_write / command events to richer session/update kinds (P1.5b)', async () => {
    const { handle } = fakeHandle((emit, finish) => {
      emit(ev('file_write', { path: 'src/x.ts', diff: '+a\n-b' }));
      emit(ev('command_completed', { command: 'npm test', exitCode: 0 }));
      finish();
    });
    const { send, waitFor } = setup(() => Promise.resolve(handle));
    send({ jsonrpc: '2.0', id: 30, method: 'session/new', params: {} });
    const created = await waitFor((m) => m.id === 30);
    send({
      jsonrpc: '2.0',
      id: 31,
      method: 'session/prompt',
      params: { sessionId: created.result?.['sessionId'], prompt: [{ type: 'text', text: 'go' }] },
    });
    const upd = (kind: string): Promise<{ params?: Record<string, unknown> }> =>
      waitFor(
        (m) =>
          m.method === 'session/update' &&
          (m.params?.['update'] as { sessionUpdate?: string } | undefined)?.sessionUpdate === kind,
      );
    const fileUpd = await upd('excalibur/file');
    expect((fileUpd.params?.['update'] as { path?: string }).path).toBe('src/x.ts');
    const cmdUpd = await upd('excalibur/command');
    expect((cmdUpd.params?.['update'] as { command?: string; exitCode?: number }).exitCode).toBe(0);
  });

  it('requests permission and approves the run on an allow outcome', async () => {
    const fake = fakeHandle((emit) => {
      emit(ev('approval_requested', { question: 'Write file?' }));
      // record is resolved by the test after approval, via cancel? no — finish via a later event
    });
    const { send, waitFor } = setup(() => Promise.resolve(fake.handle));

    send({ jsonrpc: '2.0', id: 5, method: 'session/new', params: {} });
    const created = await waitFor((m) => m.id === 5);
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'session/prompt',
      params: { sessionId: created.result?.['sessionId'], prompt: [{ type: 'text', text: 'go' }] },
    });

    // The agent asks the client for permission.
    const req = await waitFor((m) => m.method === 'session/request_permission');
    expect(req.id).toBeDefined();
    // P1.5b — the run's question is forwarded so the client knows WHAT to approve.
    expect((req.params as { question?: string }).question).toBe('Write file?');
    // Client allows.
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow' } },
    });
    // Give the microtask queue a tick to deliver the approval.
    await new Promise((r) => setImmediate(r));
    expect(fake.approvals).toEqual([true]);
  });

  it('cancels the active run on session/cancel', async () => {
    const fake = fakeHandle(() => {
      /* never finishes on its own */
    });
    const { send, waitFor } = setup(() => Promise.resolve(fake.handle));
    send({ jsonrpc: '2.0', id: 7, method: 'session/new', params: {} });
    const created = await waitFor((m) => m.id === 7);
    const sessionId = created.result?.['sessionId'];
    send({
      jsonrpc: '2.0',
      id: 8,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
    });
    await new Promise((r) => setImmediate(r));
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    const done = await waitFor((m) => m.id === 8);
    expect(fake.cancels.n).toBe(1);
    expect(done.result?.['stopReason']).toBe('cancelled');
  });
});
