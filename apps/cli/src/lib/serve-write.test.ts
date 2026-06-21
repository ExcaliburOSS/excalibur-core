import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExcaliburServer, type ServeWriteHandler } from './serve';
import { makeTempDir, removeDir } from '../test-utils';

/**
 * The programmable `serve` WRITE surface (P0.3b): POST start/cancel/approve runs.
 * Driven with a fake ServeWriteHandler (no real runs) so we test routing, body
 * parsing, auth and the read-only default deterministically.
 */

const TOKEN = 'wtok';
const RUN_ID = 'run_20260101_000000';

let repoRoot: string;
let server: Server;
let base: string;

function makeHandler(): {
  handler: ServeWriteHandler;
  calls: { start: unknown[]; cancel: string[]; approve: Array<[string, boolean]> };
} {
  const calls = {
    start: [] as unknown[],
    cancel: [] as string[],
    approve: [] as Array<[string, boolean]>,
  };
  const handler: ServeWriteHandler = {
    startRun: (input) => {
      calls.start.push(input);
      return Promise.resolve({ runId: RUN_ID });
    },
    cancel: (id) => {
      calls.cancel.push(id);
      return true;
    },
    approve: (id, decision) => {
      calls.approve.push([id, decision]);
      return true;
    },
  };
  return { handler, calls };
}

async function listen(write?: ServeWriteHandler): Promise<void> {
  server = createExcaliburServer({
    repoRoot,
    token: TOKEN,
    ...(write !== undefined ? { write } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(path: string, body?: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  repoRoot = makeTempDir();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  removeDir(repoRoot);
});

describe('serve write surface', () => {
  it('rejects writes with 403 when the write surface is disabled (read-only default)', async () => {
    await listen(); // no write handler
    const res = await post('/api/runs', { task: 'do it' });
    expect(res.status).toBe(403);
  });

  it('starts a run via POST /api/runs', async () => {
    const { handler, calls } = makeHandler();
    await listen(handler);
    const res = await post('/api/runs', { task: 'build the thing', workflow: 'fast-fix' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: RUN_ID });
    expect(calls.start).toEqual([{ task: 'build the thing', workflow: 'fast-fix' }]);
  });

  it('rejects a start with no task (400)', async () => {
    const { handler } = makeHandler();
    await listen(handler);
    const res = await post('/api/runs', { workflow: 'fast-fix' });
    expect(res.status).toBe(400);
  });

  it('cancels a run via POST /api/runs/:id/cancel', async () => {
    const { handler, calls } = makeHandler();
    await listen(handler);
    const res = await post(`/api/runs/${RUN_ID}/cancel`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(calls.cancel).toEqual([RUN_ID]);
  });

  it('approves a run via POST /api/runs/:id/approve', async () => {
    const { handler, calls } = makeHandler();
    await listen(handler);
    const res = await post(`/api/runs/${RUN_ID}/approve`, { decision: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls.approve).toEqual([[RUN_ID, true]]);
  });

  it('rejects an approve with no boolean decision (400)', async () => {
    const { handler } = makeHandler();
    await listen(handler);
    const res = await post(`/api/runs/${RUN_ID}/approve`, {});
    expect(res.status).toBe(400);
  });

  it('rejects an invalid run id (400)', async () => {
    const { handler } = makeHandler();
    await listen(handler);
    const res = await post('/api/runs/not-a-run/cancel');
    expect(res.status).toBe(400);
  });

  it('still requires the token on writes (401)', async () => {
    const { handler } = makeHandler();
    await listen(handler);
    const res = await post('/api/runs', { task: 'x' }, 'wrong-token');
    expect(res.status).toBe(401);
  });
});
