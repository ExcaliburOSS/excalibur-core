import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunManager, savePlan } from '@excalibur/core';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import { createEvent } from '@excalibur/shared';
import type { Server } from 'node:http';
import { createExcaliburServer } from './serve';
import { dashboardHtml } from './dashboard';
import { makeTempDir, removeDir } from '../test-utils';

const TOKEN = 'test-token-abc';

describe('excalibur serve (HTTP/SSE over the event stream)', () => {
  let repoRoot: string;
  let server: Server;
  let base: string;
  let runId: string;
  let workItemKey: string;

  beforeAll(async () => {
    repoRoot = makeTempDir();
    // A work item the board + drill-down endpoints surface (task-first IA, D0).
    workItemKey = new LocalWorkItemProvider(repoRoot).createWorkItem({
      title: 'Wire the dashboard',
      status: 'in_progress',
      labels: ['dashboard'],
    }).key;
    const manager = new RunManager(repoRoot);
    const run = manager.createRun({
      title: 'Add a feature',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      model: 'kimi',
      executionStyle: 'fast',
      workItemId: workItemKey,
    });
    runId = run.id;
    manager.appendEvent(
      run.id,
      createEvent({ runId: run.id, type: 'run_started', payload: { title: 'Add a feature' } }),
    );
    manager.appendEvent(
      run.id,
      createEvent({
        runId: run.id,
        type: 'phase_started',
        payload: { name: 'Analyze' },
        phaseId: 'p1',
      }),
    );
    manager.appendModelCall(run.id, {
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      inputTokens: 100,
      outputTokens: 50,
      costCents: 2,
      timestamp: new Date().toISOString(),
    });
    manager.appendEvent(
      run.id,
      createEvent({
        runId: run.id,
        type: 'model_call',
        payload: { model: 'kimi-k2.7-code', costCents: 2, inputTokens: 100, outputTokens: 50 },
        phaseId: 'p1',
      }),
    );
    manager.appendEvent(
      run.id,
      createEvent({ runId: run.id, type: 'run_completed', payload: { status: 'completed' } }),
    );
    manager.updateRecord(run.id, { status: 'completed', completedAt: new Date().toISOString() });

    server = createExcaliburServer({ repoRoot, token: TOKEN, pollMs: 50 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    removeDir(repoRoot);
  });

  const get = (path: string, token = TOKEN): Promise<Response> =>
    fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`);

  it('serves a web dashboard at / (HTML, token-gated)', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // Invariants true of BOTH the embedded Svelte app and the legacy fallback
    // (which one serves depends on whether the dashboard has been built).
    expect(html.toLowerCase()).toContain('excalibur');
    expect(html).toContain('/api/'); // the client calls the JSON API
    // The dashboard is behind the token too.
    expect((await fetch(`${base}/`)).status).toBe(401);
  });

  it('the legacy fallback dashboard escapes untrusted fields + sets a CSP', () => {
    // The inline page is the fallback when the Svelte build is absent; its
    // stored-XSS guards (escape untrusted run titles / agent text) + CSP are
    // verified directly so the assertion is independent of build state.
    const html = dashboardHtml();
    expect(html).toContain('const esc=');
    expect(html).toContain('esc(record.title)');
    expect(html).toContain('esc(e.text');
    expect(html).toContain('esc(r.workflow)');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain("'<p class=title>'+record.title");
  });

  it('rejects a request with no/invalid token (401)', async () => {
    const res = await fetch(`${base}/api/runs`);
    expect(res.status).toBe(401);
    const bad = await get('/api/runs', 'wrong');
    expect(bad.status).toBe(401);
  });

  it('lists runs', async () => {
    const res = await get('/api/runs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ id: string; status: string }> };
    expect(body.runs.some((r) => r.id === runId && r.status === 'completed')).toBe(true);
  });

  it('returns a run detail with the reduced rail', async () => {
    const res = await get(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      record: { title: string };
      rail: { phases: unknown[]; status: { costCents: number } };
    };
    expect(body.record.title).toBe('Add a feature');
    expect(Array.isArray(body.rail.phases)).toBe(true);
    expect(body.rail.status.costCents).toBe(2);
  });

  it('returns the raw event list', async () => {
    const res = await get(`/api/runs/${runId}/events`);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    expect(body.events[0]?.type).toBe('run_started');
    expect(body.events.some((e) => e.type === 'run_completed')).toBe(true);
  });

  it('serves the cross-run insights report', async () => {
    const res = await get('/api/insights');
    const body = (await res.json()) as { totalRuns: number; totalCostCents: number };
    expect(body.totalRuns).toBeGreaterThanOrEqual(1);
    expect(body.totalCostCents).toBe(2);
  });

  it('404s an unknown run and 400s a malformed id', async () => {
    expect((await get('/api/runs/run_20990101_000000')).status).toBe(404);
    expect((await get('/api/runs/not-a-run')).status).toBe(400);
  });

  it('serves the task-first kanban board (work items projected onto lanes)', async () => {
    const res = await get('/api/board');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lanes: { lane: string; label: string; items: { key: string; runCount: number }[] }[];
      generatedAt: string;
    };
    expect(body.lanes.map((l) => l.lane)).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'review',
      'done',
    ]);
    const card = body.lanes
      .find((l) => l.lane === 'in_progress')
      ?.items.find((i) => i.key === workItemKey);
    expect(card).toBeDefined();
    expect(card?.runCount).toBeGreaterThanOrEqual(1); // the linked run
    expect(typeof body.generatedAt).toBe('string');
  });

  it('serves a work-item drill-down with its linked runs', async () => {
    const res = await get(`/api/work-items/${workItemKey}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      key: string;
      lane: string;
      runs: { id: string; workItemId: string | null }[];
    };
    expect(body.key).toBe(workItemKey);
    expect(body.lane).toBe('in_progress');
    expect(body.runs.some((r) => r.id === runId && r.workItemId === workItemKey)).toBe(true);
  });

  it('404s an unknown work item and 400s a malformed key', async () => {
    expect((await get('/api/work-items/WI-9999')).status).toBe(404);
    expect((await get('/api/work-items/not-a-key')).status).toBe(400);
  });

  it('streams a completed run as SSE (replays events, ends)', async () => {
    const res = await get(`/api/runs/${runId}/stream`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text(); // a completed run replays then ends → resolves
    expect(text).toContain('event: run_started');
    expect(text).toContain('event: run_completed');
    expect(text).toContain('event: end');
  });

  it('handles a stream URL with a trailing slash (normalized id, no empty-id crash)', async () => {
    // route() matches on the trailing-slash-normalized path, so the id must be
    // derived from the SAME normalization — a raw-pathname regex would yield ''.
    const res = await get(`/api/runs/${runId}/stream/`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: run_started');
    expect(text).toContain('event: end');
  });

  it('TAILS events appended AFTER the stream opens (incremental byte-offset tail)', async () => {
    const manager = new RunManager(repoRoot);
    const run = manager.createRun({
      title: 'live',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      executionStyle: 'fast',
    });
    // Only run_started exists when the client connects (no run_completed yet).
    manager.appendEvent(
      run.id,
      createEvent({ runId: run.id, type: 'run_started', payload: { title: 'live' } }),
    );
    const res = await get(`/api/runs/${run.id}/stream`);
    // Append more events AFTER the stream is open — the tail must pick them up.
    manager.appendEvent(
      run.id,
      createEvent({
        runId: run.id,
        type: 'phase_started',
        payload: { name: 'Analyze' },
        phaseId: 'p1',
      }),
    );
    manager.appendEvent(
      run.id,
      createEvent({
        runId: run.id,
        type: 'file_write',
        payload: { path: 'src/x.ts' },
        phaseId: 'p1',
      }),
    );
    manager.appendEvent(
      run.id,
      createEvent({ runId: run.id, type: 'run_completed', payload: { status: 'completed' } }),
    );
    const text = await res.text(); // resolves once run_completed → end closes the stream
    expect(text).toContain('event: run_started'); // replayed on connect
    expect(text).toContain('event: phase_started'); // tailed after connect
    expect(text).toContain('event: file_write'); // tailed after connect
    expect(text).toContain('event: run_completed');
    expect(text).toContain('event: end');
  });
});

describe('excalibur serve — interactive write surface (D2)', () => {
  let repoRoot: string;
  let server: Server;
  let base: string;
  let wiKey: string;
  const startCalls: Array<{ task: string; workItemId?: string }> = [];

  beforeAll(async () => {
    repoRoot = makeTempDir();
    wiKey = new LocalWorkItemProvider(repoRoot).createWorkItem({
      title: 'Drag me',
      status: 'todo',
    }).key;
    const write = {
      startRun: (input: { task: string; workItemId?: string }) => {
        startCalls.push(input);
        return Promise.resolve({ runId: 'run_20260101_000000' });
      },
      cancel: () => true,
      approve: () => true,
    };
    server = createExcaliburServer({ repoRoot, token: TOKEN, pollMs: 50, write });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    removeDir(repoRoot);
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('/health reports write: true when the write surface is on', async () => {
    const res = await fetch(`${base}/health?token=${TOKEN}`);
    const body = (await res.json()) as { write: boolean };
    expect(body.write).toBe(true);
  });

  it('moves a work item to another lane', async () => {
    const res = await post(`/api/work-items/${wiKey}/move`, { lane: 'done' });
    expect(res.status).toBe(200);
    const card = (await res.json()) as { key: string; lane: string };
    expect(card.key).toBe(wiKey);
    expect(card.lane).toBe('done');
  });

  it('400s an invalid lane and 404s an unknown work item', async () => {
    expect((await post(`/api/work-items/${wiKey}/move`, { lane: 'nonsense' })).status).toBe(400);
    expect((await post('/api/work-items/WI-9999/move', { lane: 'done' })).status).toBe(404);
  });

  it('passes workItemId through to startRun', async () => {
    startCalls.length = 0;
    const res = await post('/api/runs', { task: 'do it', workItemId: wiKey });
    expect(res.status).toBe(201);
    expect(startCalls[0]).toMatchObject({ task: 'do it', workItemId: wiKey });
    // a malformed workItemId is rejected
    expect((await post('/api/runs', { task: 'x', workItemId: 'evil/../x' })).status).toBe(400);
  });
});

describe('excalibur serve — plans & discovery (D3)', () => {
  let repoRoot: string;
  let server: Server;
  let base: string;
  let planId: string;

  beforeAll(async () => {
    repoRoot = makeTempDir();
    const file = savePlan(repoRoot, {
      task: 'Ship the dashboard',
      planMarkdown: '1. board\n2. detail',
      status: 'approved',
      planRunId: 'run_plan_x',
      now: new Date('2026-06-22T10:00:00.000Z'),
    });
    planId = file.replace(/.*\//, '').replace(/\.md$/, '');
    server = createExcaliburServer({ repoRoot, token: TOKEN, pollMs: 50 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    removeDir(repoRoot);
  });
  const get = (p: string): Promise<Response> => fetch(`${base}${p}?token=${TOKEN}`);

  it('lists saved plans and serves a plan body', async () => {
    const list = (await (await get('/api/plans')).json()) as {
      plans: { id: string; task: string; status: string }[];
    };
    expect(list.plans.some((p) => p.id === planId && p.task === 'Ship the dashboard')).toBe(true);

    const detail = (await (await get(`/api/plans/${planId}`)).json()) as { body: string };
    expect(detail.body).toContain('2. detail');

    expect((await get('/api/plans/nope-not-real')).status).toBe(404);
  });

  it('serves the (empty) discovery list', async () => {
    const res = await get('/api/discovery');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { discovery: unknown[] };
    expect(Array.isArray(body.discovery)).toBe(true);
  });
});

describe('excalibur serve — write surface OFF (read-only)', () => {
  let repoRoot: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    repoRoot = makeTempDir();
    server = createExcaliburServer({ repoRoot, token: TOKEN, pollMs: 50 }); // no write
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    removeDir(repoRoot);
  });

  it('/health reports write: false and a move is refused with 403', async () => {
    const health = (await (await fetch(`${base}/health?token=${TOKEN}`)).json()) as {
      write: boolean;
    };
    expect(health.write).toBe(false);
    const res = await fetch(`${base}/api/work-items/WI-1/move?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane: 'done' }),
    });
    expect(res.status).toBe(403);
  });
});
