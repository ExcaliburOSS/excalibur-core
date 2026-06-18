import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunManager } from '@excalibur/core';
import { createEvent } from '@excalibur/shared';
import type { Server } from 'node:http';
import { createExcaliburServer } from './serve';
import { makeTempDir, removeDir } from '../test-utils';

const TOKEN = 'test-token-abc';

describe('excalibur serve (HTTP/SSE over the event stream)', () => {
  let repoRoot: string;
  let server: Server;
  let base: string;
  let runId: string;

  beforeAll(async () => {
    repoRoot = makeTempDir();
    const manager = new RunManager(repoRoot);
    const run = manager.createRun({
      title: 'Add a feature',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      model: 'kimi',
      executionStyle: 'fast',
    });
    runId = run.id;
    manager.appendEvent(run.id, createEvent({ runId: run.id, type: 'run_started', payload: { title: 'Add a feature' } }));
    manager.appendEvent(run.id, createEvent({ runId: run.id, type: 'phase_started', payload: { name: 'Analyze' }, phaseId: 'p1' }));
    manager.appendModelCall(run.id, { provider: 'kimi', model: 'kimi-k2.7-code', inputTokens: 100, outputTokens: 50, costCents: 2, timestamp: new Date().toISOString() });
    manager.appendEvent(run.id, createEvent({ runId: run.id, type: 'model_call', payload: { model: 'kimi-k2.7-code', costCents: 2, inputTokens: 100, outputTokens: 50 }, phaseId: 'p1' }));
    manager.appendEvent(run.id, createEvent({ runId: run.id, type: 'run_completed', payload: { status: 'completed' } }));
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

  it('serves the self-contained web dashboard at / (HTML, token-gated)', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('EXCALIBUR');
    expect(html).toContain('/api/runs'); // the embedded client calls the API
    expect(html).toContain('/api/insights');
    // Stored-XSS guard: untrusted fields (run titles, agent event text) MUST be
    // escaped before innerHTML, and a CSP limits exfiltration as defense-in-depth.
    expect(html).toContain('const esc=');
    expect(html).toContain('esc(record.title)');
    expect(html).toContain('esc(e.text');
    expect(html).toContain('esc(r.workflow)');
    expect(html).toContain('Content-Security-Policy');
    // No raw (unescaped) interpolation of the untrusted run title remains.
    expect(html).not.toContain("'<p class=title>'+record.title");
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
    const body = (await res.json()) as { record: { title: string }; rail: { phases: unknown[]; status: { costCents: number } } };
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

  it('streams a completed run as SSE (replays events, ends)', async () => {
    const res = await get(`/api/runs/${runId}/stream`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text(); // a completed run replays then ends → resolves
    expect(text).toContain('event: run_started');
    expect(text).toContain('event: run_completed');
    expect(text).toContain('event: end');
  });

  it('TAILS events appended AFTER the stream opens (incremental byte-offset tail)', async () => {
    const manager = new RunManager(repoRoot);
    const run = manager.createRun({ title: 'live', autonomyLevel: 3, workflow: 'fast-fix', executionStyle: 'fast' });
    // Only run_started exists when the client connects (no run_completed yet).
    manager.appendEvent(run.id, createEvent({ runId: run.id, type: 'run_started', payload: { title: 'live' } }));
    const res = await get(`/api/runs/${run.id}/stream`);
    // Append more events AFTER the stream is open — the tail must pick them up.
    manager.appendEvent(run.id, createEvent({ runId: run.id, type: 'phase_started', payload: { name: 'Analyze' }, phaseId: 'p1' }));
    manager.appendEvent(run.id, createEvent({ runId: run.id, type: 'file_write', payload: { path: 'src/x.ts' }, phaseId: 'p1' }));
    manager.appendEvent(run.id, createEvent({ runId: run.id, type: 'run_completed', payload: { status: 'completed' } }));
    const text = await res.text(); // resolves once run_completed → end closes the stream
    expect(text).toContain('event: run_started'); // replayed on connect
    expect(text).toContain('event: phase_started'); // tailed after connect
    expect(text).toContain('event: file_write'); // tailed after connect
    expect(text).toContain('event: run_completed');
    expect(text).toContain('event: end');
  });
});
