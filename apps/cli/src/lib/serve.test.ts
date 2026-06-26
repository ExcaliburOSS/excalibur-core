import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunManager, savePlan } from '@excalibur/core';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import { createEvent } from '@excalibur/shared';
import type { Server } from 'node:http';
import { createExcaliburServer } from './serve';
import { dashboardAppHtml } from './dashboard-app';
import { loadOrchestrationControl } from './orchestration-manifest';
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
    // Either the built Svelte work-item app (which calls the JSON API) or the
    // honest "not built" page — both are branded, and the run-centric legacy page
    // is gone for good.
    expect(html.toLowerCase()).toContain('excalibur');
    expect(html).not.toContain('local run dashboard'); // the legacy page is removed
    if (dashboardAppHtml() !== null) {
      expect(html).toContain('/api/'); // the Svelte client calls the JSON API
    } else {
      expect(html.toLowerCase()).toContain('not been built');
    }
    // The dashboard is behind the token too.
    expect((await fetch(`${base}/`)).status).toBe(401);
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

  it('400s a path-traversal id on the sessions/plans/missions detail routes (DASH review fix)', async () => {
    // The WHATWG URL parser keeps %2F/%2e%2e encoded, so the `[^/]+` capture matches
    // — the isTraversalId guard must reject it before any filesystem join.
    expect((await get('/api/sessions/..%2F..%2F..%2Fsecret')).status).toBe(400);
    expect((await get('/api/plans/..%2Fx')).status).toBe(400);
    expect((await get('/api/missions/..%2Fx')).status).toBe(400);
    // A legit-shaped but unknown id still 404s (the guard does not over-reject).
    expect((await get('/api/sessions/sess_20990101_000000')).status).toBe(404);
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

  it('serves the orchestration chronogram (waves + lanes joined to live runs); guards bad ids (AO6 Pillar 2)', async () => {
    const manager = new RunManager(repoRoot);
    const parent = manager.createRun({
      title: 'swarm: 2 lanes',
      autonomyLevel: 3,
      workflow: 'swarm',
      model: 'kimi',
      executionStyle: 'fast',
    });
    manager.updateRecord(parent.id, { status: 'running' });
    const childA = manager.createRun({
      title: 'Lane A',
      autonomyLevel: 3,
      workflow: 'swarm-lane',
      model: 'kimi',
      executionStyle: 'fast',
      parentRunId: parent.id,
    });
    manager.updateRecord(childA.id, { status: 'completed', completedAt: new Date().toISOString() });
    const childB = manager.createRun({
      title: 'Lane B',
      autonomyLevel: 3,
      workflow: 'swarm-lane',
      model: 'kimi',
      executionStyle: 'fast',
      parentRunId: parent.id,
    });
    manager.updateRecord(childB.id, { status: 'running' });
    manager.writeArtifact(
      parent.id,
      'orchestration-plan.json',
      JSON.stringify({
        version: 1,
        task: 'do two things',
        mode: 'staged',
        parentRunId: parent.id,
        createdAt: new Date().toISOString(),
        waves: [['t1'], ['t2']],
        lanes: [
          { id: 't1', title: 'Lane A', instruction: 'A', dependsOn: [], runId: childA.id },
          { id: 't2', title: 'Lane B', instruction: 'B', dependsOn: ['t1'], runId: childB.id },
        ],
      }),
    );

    const res = await get(`/api/orchestrations/${parent.id}`);
    expect(res.status).toBe(200);
    const dto = (await res.json()) as {
      parentRunId: string;
      waves: string[][];
      lanes: { id: string; state: string; dependsOn: string[]; runId: string | null }[];
    };
    expect(dto.parentRunId).toBe(parent.id);
    expect(dto.waves).toEqual([['t1'], ['t2']]);
    expect(dto.lanes).toHaveLength(2);
    expect(dto.lanes[0]?.state).toBe('done'); // childA completed
    expect(dto.lanes[1]?.state).toBe('running'); // childB still running
    expect(dto.lanes[1]?.dependsOn).toEqual(['t1']); // the DAG edge
    expect(dto.lanes[1]?.runId).toBe(childB.id); // click-through target

    // Guards: unknown parent → 404, malformed id → 400.
    expect((await get('/api/orchestrations/run_20990101_000000')).status).toBe(404);
    expect((await get('/api/orchestrations/not-a-run')).status).toBe(400);
  });

  it('lists orchestrations with per-lane work item ids + streams the list (AO4e-3)', async () => {
    const manager = new RunManager(repoRoot);
    const parent = manager.createRun({
      title: 'swarm: wi',
      autonomyLevel: 3,
      workflow: 'swarm',
      workItemId: 'WI-42',
    });
    const child = manager.createRun({
      title: 'Lane WI',
      autonomyLevel: 3,
      workflow: 'swarm-lane',
      parentRunId: parent.id,
      workItemId: 'WI-42',
    });
    manager.updateRecord(child.id, { status: 'running' });

    // The LIST projects the per-lane work item (was missing → dead linkage).
    const list = (await (await get('/api/orchestrations')).json()) as {
      orchestrations: {
        parentRunId: string;
        lanes: { runId: string; workItemId: string | null }[];
      }[];
    };
    const o = list.orchestrations.find((x) => x.parentRunId === parent.id)!;
    expect(o.lanes[0]?.workItemId).toBe('WI-42');

    // The LIST stream emits an `orchestrations` frame (replaces the 3s poll).
    const res = await fetch(`${base}/api/orchestrations/stream?token=${TOKEN}`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: orchestrations');
    expect(text).toContain('"workItemId":"WI-42"');
    await reader.cancel();
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
      shapePlan: () =>
        Promise.resolve({
          complexity: 'small' as const,
          clear: true,
          questions: [],
          recommendations: [],
          surface: false,
        }),
      scope: () => Promise.resolve(null),
      scheduleAdd: () => null,
      scheduleRemove: () => false,
      scheduleSetEnabled: () => false,
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

  it('creates a work item (201) and rejects a blank title (400)', async () => {
    const res = await post('/api/work-items', { title: 'Built from the board', labels: ['ui'] });
    expect(res.status).toBe(201);
    const card = (await res.json()) as { key: string; title: string; labels: string[] };
    expect(card.key).toMatch(/^WI-\d+$/);
    expect(card.title).toBe('Built from the board');
    expect(card.labels).toEqual(['ui']);
    expect((await post('/api/work-items', { title: '   ' })).status).toBe(400);
  });

  it('edits a work item (200) and 404s an unknown key', async () => {
    const res = await post(`/api/work-items/${wiKey}`, { title: 'Renamed', priority: 'high' });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { title: string; priority: string | null };
    expect(detail.title).toBe('Renamed');
    expect(detail.priority).toBe('high');
    expect((await post('/api/work-items/WI-9999', { title: 'x' })).status).toBe(404);
  });

  it('adds a comment (200) and rejects an empty one (400)', async () => {
    const res = await post(`/api/work-items/${wiKey}/comment`, { body: 'on it' });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { comments: unknown[] };
    expect(detail.comments.length).toBeGreaterThan(0);
    expect((await post(`/api/work-items/${wiKey}/comment`, { body: '  ' })).status).toBe(400);
  });

  it('deletes a work item (200) then 404s it', async () => {
    const created = (await (await post('/api/work-items', { title: 'Disposable' })).json()) as {
      key: string;
    };
    expect((await post(`/api/work-items/${created.key}/delete`, {})).status).toBe(200);
    expect((await post(`/api/work-items/${created.key}/delete`, {})).status).toBe(404);
  });

  it('authored checklist: add → toggle → remove', async () => {
    type Detail = { authoredChecklist: { id: string; text: string; done: boolean }[] };
    let d = (await (
      await post(`/api/work-items/${wiKey}/checklist`, { action: 'add', text: 'write a test' })
    ).json()) as Detail;
    expect(d.authoredChecklist).toHaveLength(1);
    expect(d.authoredChecklist[0]!.done).toBe(false);
    const id = d.authoredChecklist[0]!.id;
    d = (await (
      await post(`/api/work-items/${wiKey}/checklist`, { action: 'toggle', id })
    ).json()) as Detail;
    expect(d.authoredChecklist[0]!.done).toBe(true);
    d = (await (
      await post(`/api/work-items/${wiKey}/checklist`, { action: 'remove', id })
    ).json()) as Detail;
    expect(d.authoredChecklist).toHaveLength(0);
    // A malformed op is a 400.
    expect((await post(`/api/work-items/${wiKey}/checklist`, { action: 'nope' })).status).toBe(400);
  });

  it('passes workItemId through to startRun', async () => {
    startCalls.length = 0;
    const res = await post('/api/runs', { task: 'do it', workItemId: wiKey });
    expect(res.status).toBe(201);
    expect(startCalls[0]).toMatchObject({ task: 'do it', workItemId: wiKey });
    // a malformed workItemId is rejected
    expect((await post('/api/runs', { task: 'x', workItemId: 'evil/../x' })).status).toBe(400);
  });

  it('cancels ONE lane of an orchestration (AO4e-3) — writes the control file', async () => {
    const manager = new RunManager(repoRoot);
    const parent = manager.createRun({ title: 'swarm', autonomyLevel: 3, workflow: 'swarm' });
    const child = manager.createRun({
      title: 'Lane',
      autonomyLevel: 3,
      workflow: 'swarm-lane',
      parentRunId: parent.id,
    });
    const res = await post(`/api/orchestrations/${parent.id}/lanes/${child.id}/cancel`, {});
    expect(res.status).toBe(200);
    expect((await res.json()) as { cancelled: boolean }).toEqual({ cancelled: true });
    // The control file the live lane gate polls now lists this lane's child run.
    expect(loadOrchestrationControl(repoRoot, parent.id)?.cancelledRunIds).toEqual([child.id]);
    // Malformed ids are rejected.
    expect((await post(`/api/orchestrations/not-a-run/lanes/${child.id}/cancel`, {})).status).toBe(
      400,
    );
  });
});

describe('excalibur serve — live board SSE + read-only share token (D5)', () => {
  let repoRoot: string;
  let server: Server;
  let base: string;
  const SHARE = 'share-token-xyz';

  beforeAll(async () => {
    repoRoot = makeTempDir();
    new LocalWorkItemProvider(repoRoot).createWorkItem({ title: 'On the board', status: 'todo' });
    const write = {
      startRun: () => Promise.resolve({ runId: 'run_20260101_000000' }),
      cancel: () => true,
      approve: () => true,
      shapePlan: () =>
        Promise.resolve({
          complexity: 'small' as const,
          clear: true,
          questions: [],
          recommendations: [],
          surface: false,
        }),
      scope: () => Promise.resolve(null),
      scheduleAdd: () => null,
      scheduleRemove: () => false,
      scheduleSetEnabled: () => false,
    };
    server = createExcaliburServer({
      repoRoot,
      token: TOKEN,
      pollMs: 50,
      write,
      shareToken: SHARE,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
    removeDir(repoRoot);
  });

  it('streams the board over SSE (initial snapshot frame)', async () => {
    const res = await fetch(`${base}/api/board/stream?token=${TOKEN}`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: board');
    expect(text).toContain('"lanes"');
    await reader.cancel();
  });

  it('share token: reads work, /health shows write:false, mutations are 403', async () => {
    // GET with the share token succeeds.
    const board = await fetch(`${base}/api/board?token=${SHARE}`);
    expect(board.status).toBe(200);
    // Even though --write is on, a share-token viewer sees write:false…
    const health = (await (await fetch(`${base}/health?token=${SHARE}`)).json()) as {
      write: boolean;
    };
    expect(health.write).toBe(false);
    // …and any mutation is refused.
    const move = await fetch(`${base}/api/work-items/WI-1/move?token=${SHARE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane: 'done' }),
    });
    expect(move.status).toBe(403);
    // The PRIMARY token still sees write:true.
    const primary = (await (await fetch(`${base}/health?token=${TOKEN}`)).json()) as {
      write: boolean;
    };
    expect(primary.write).toBe(true);
  });

  it('rejects an unknown token (401)', async () => {
    expect((await fetch(`${base}/api/board?token=nope`)).status).toBe(401);
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
