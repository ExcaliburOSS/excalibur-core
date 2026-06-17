import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { collectInsights, RunManager } from '@excalibur/core';
import type { ExcaliburEvent } from '@excalibur/shared';
import { reduceRail } from '@excalibur/tui';
import { dashboardHtml } from './dashboard';

/**
 * `excalibur serve` (plan P1.12 / the headless-server enabler) — a local,
 * single-user HTTP + SSE surface over the `ExcaliburEvent` stream. It is the
 * server the OSS web dashboard (`@excalibur/web-ui`) and any remote viewer fold
 * the SAME `reduceRail` over, so the web view is byte-identical to the TUI rail.
 *
 * SECURITY: binds to localhost by default and requires a per-process token
 * (printed once). Read-only: it exposes runs/events/insights; it never executes.
 *
 * Pure factory: {@link createExcaliburServer} returns an `http.Server` so tests
 * drive it with real requests; the command wires it to a port + the console.
 */

export interface ServeOptions {
  repoRoot: string;
  /** Shared secret required on every request (`?token=` or `Authorization: Bearer`). */
  token: string;
  /** Injectable clock for the SSE poll loop (tests). */
  pollMs?: number;
}

interface Json {
  status: number;
  body: unknown;
}

interface Html {
  status: number;
  html: string;
}

const RUN_ID = /^run_\d{8}_\d{6}(?:_[a-z0-9]+)?$/;

/** Extracts the bearer/query token from a request. */
function tokenOf(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return url.searchParams.get('token');
}

/** Routes a request to a payload, an HTML page, or 'sse' for the stream route. */
function route(repoRoot: string, url: URL): Json | Html | 'sse' | null {
  const manager = new RunManager(repoRoot);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/') {
    return { status: 200, html: dashboardHtml() };
  }
  if (path === '/health') {
    return { status: 200, body: { ok: true, service: 'excalibur', repoRoot } };
  }
  if (path === '/api/runs') {
    return { status: 200, body: { runs: manager.listRuns().map((r) => r.record) } };
  }
  if (path === '/api/insights') {
    return { status: 200, body: collectInsights(repoRoot) };
  }
  const runMatch = /^\/api\/runs\/([^/]+)(\/events|\/stream)?$/.exec(path);
  if (runMatch !== null) {
    const id = decodeURIComponent(runMatch[1] as string);
    if (!RUN_ID.test(id)) {
      return { status: 400, body: { error: 'invalid run id' } };
    }
    let events;
    try {
      events = manager.readEvents(id);
    } catch {
      return { status: 404, body: { error: `run ${id} not found` } };
    }
    if (runMatch[2] === '/stream') {
      return 'sse';
    }
    if (runMatch[2] === '/events') {
      return { status: 200, body: { events } };
    }
    // The run detail: record + the reduced rail (live = scrub = replay = web).
    return {
      status: 200,
      body: { record: manager.getRun(id).record, rail: reduceRail(events) },
    };
  }
  return { status: 404, body: { error: 'not found' } };
}

/** Streams a run's events as SSE: replay all, then tail appended lines until done. */
function streamRun(
  repoRoot: string,
  id: string,
  res: ServerResponse,
  pollMs: number,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const manager = new RunManager(repoRoot);
  let sent = 0;
  let done = false;

  const flush = (): void => {
    let events: ExcaliburEvent[];
    try {
      events = manager.readEvents(id);
    } catch {
      events = [];
    }
    for (let i = sent; i < events.length; i += 1) {
      const event = events[i];
      res.write(`event: ${event?.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event?.type === 'run_completed') {
        done = true;
      }
    }
    sent = events.length;
  };

  flush();
  if (done) {
    res.write('event: end\ndata: {}\n\n');
    res.end();
    return;
  }
  // Tail: poll the event log for appends until the run completes or the client
  // disconnects. Polling is more portable than fs.watch across platforms/FS.
  const timer = setInterval(() => {
    flush();
    if (done) {
      res.write('event: end\ndata: {}\n\n');
      clearInterval(timer);
      res.end();
    }
  }, pollMs);
  timer.unref?.();
  res.on('close', () => clearInterval(timer));
}

/** Builds the (read-only, token-gated) Excalibur HTTP/SSE server. */
export function createExcaliburServer(options: ServeOptions): Server {
  const pollMs = options.pollMs ?? 500;
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (tokenOf(req, url) !== options.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized — pass ?token= or Authorization: Bearer' }));
      return;
    }
    let result: Json | Html | 'sse' | null;
    try {
      result = route(options.repoRoot, url);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (result === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (result === 'sse') {
      const id = decodeURIComponent(/\/api\/runs\/([^/]+)\/stream$/.exec(url.pathname)?.[1] ?? '');
      streamRun(options.repoRoot, id, res, pollMs);
      return;
    }
    if ('html' in result) {
      res.writeHead(result.status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.html);
      return;
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
}

/** Best-effort run-dir existence (used by the command for a friendly hint). */
export function runsDirExists(repoRoot: string): boolean {
  try {
    return statSync(join(repoRoot, '.excalibur', 'runs')).isDirectory();
  } catch {
    return false;
  }
}
