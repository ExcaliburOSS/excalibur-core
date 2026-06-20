import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { collectInsights, RunManager } from '@excalibur/core';
import { reduceRail } from '@excalibur/tui';
import { dashboardHtml } from './dashboard';

/**
 * `excalibur serve` (plan P1.12 / the headless-server enabler) — a local,
 * single-user HTTP + SSE surface over the `ExcaliburEvent` stream. It is the
 * server the built-in OSS web dashboard (see `./dashboard`) and any remote viewer
 * fold the SAME `reduceRail` over, so the web view is byte-identical to the TUI rail.
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
      // Bound the response: `?after=<index>` pages from a cursor, `?limit` caps
      // the count (default 5000) so a huge event log can't return one vast body.
      const after = Math.min(
        Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0),
        events.length,
      );
      const limit = Math.min(
        5000,
        Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '5000', 10) || 5000),
      );
      const slice = events.slice(after, after + limit);
      return {
        status: 200,
        body: {
          events: slice,
          total: events.length,
          nextCursor: Math.min(after + slice.length, events.length),
        },
      };
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
function streamRun(repoRoot: string, id: string, res: ServerResponse, pollMs: number): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const path = new RunManager(repoRoot).eventsPath(id);
  // INCREMENTAL tail: track a byte offset + read ONLY the bytes appended since the
  // last poll (buffering a partial trailing line), so streaming a long run is
  // O(total) instead of re-reading + re-parsing the whole log on every tick.
  let offset = 0;
  let lineBuffer = '';
  let done = false;
  // Decode bytes through a StringDecoder so a multi-byte UTF-8 char split across
  // two reads is held + completed on the next read (a plain per-chunk toString
  // would corrupt it — events.jsonl can contain non-ASCII paths/messages).
  const decoder = new StringDecoder('utf8');

  const flush = (): void => {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return; // events.jsonl not created yet
    }
    if (size <= offset) return;
    let fd: number | null = null;
    try {
      fd = openSync(path, 'r');
      const length = size - offset;
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, offset);
      offset += read;
      lineBuffer += decoder.write(buf.subarray(0, read));
    } catch {
      return;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    let nl = lineBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = lineBuffer.slice(0, nl).trim();
      lineBuffer = lineBuffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          const event = JSON.parse(line) as { type?: string };
          res.write(`event: ${event.type ?? 'message'}\ndata: ${line}\n\n`);
          if (event.type === 'run_completed') done = true;
        } catch {
          // a corrupt/partial line — skip it
        }
      }
      nl = lineBuffer.indexOf('\n');
    }
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
