import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { collectInsights, RunManager } from '@excalibur/core';
import { reduceRail } from '@excalibur/tui';
import { dashboardHtml } from './dashboard';
import { dashboardAppHtml } from './dashboard-app';
import {
  buildBoard,
  buildWorkItemDetail,
  moveWorkItemLane,
  InvalidLaneError,
} from './dashboard-data';

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

/**
 * The write surface (P0.3b). When supplied, `serve` becomes a control plane:
 * POST endpoints start / cancel / approve runs (driven by a `RunController`).
 * Omitted → the server stays strictly read-only (a POST returns 403). Injected
 * (not built in `serve.ts`) so this module stays free of the run pipeline + so
 * tests can drive it with a fake.
 */
export interface ServeWriteHandler {
  /** Start a run for a task; returns its id. */
  startRun(input: {
    task: string;
    workflow?: string;
    autonomyLevel?: number;
    executionStyle?: string;
    /** Link the run to a work item (D2: "start a run on this card"). */
    workItemId?: string;
  }): Promise<{ runId: string }>;
  /** Cancel a run; false if unknown. */
  cancel(runId: string): boolean;
  /** Answer a run's pending approval; false if the run is unknown. */
  approve(runId: string, decision: boolean): boolean;
}

export interface ServeOptions {
  repoRoot: string;
  /** Shared secret required on every request (`?token=` or `Authorization: Bearer`). */
  token: string;
  /** Injectable clock for the SSE poll loop (tests). */
  pollMs?: number;
  /** When set, enables the POST write surface (start/cancel/approve runs). */
  write?: ServeWriteHandler;
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
const WORK_ITEM_PATH = /^\/api\/work-items\/([^/]+)$/;
const WORK_ITEM_KEY = /^WI-\d+$/;

/** Extracts the bearer/query token from a request. */
function tokenOf(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return url.searchParams.get('token');
}

/** Routes a request to a payload, an HTML page, or 'sse' for the stream route. */
function route(repoRoot: string, url: URL, writable: boolean): Json | Html | 'sse' | null {
  const manager = new RunManager(repoRoot);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/') {
    // Prefer the embedded Svelte dashboard (D0); fall back to the legacy inline
    // page when the dashboard hasn't been built (e.g. dev/tests).
    return { status: 200, html: dashboardAppHtml() ?? dashboardHtml() };
  }
  if (path === '/health') {
    // `write` lets the dashboard enable/disable its interactive actions (D2).
    return { status: 200, body: { ok: true, service: 'excalibur', repoRoot, write: writable } };
  }
  if (path === '/api/runs') {
    return { status: 200, body: { runs: manager.listRuns().map((r) => r.record) } };
  }
  if (path === '/api/insights') {
    return { status: 200, body: collectInsights(repoRoot) };
  }
  if (path === '/api/board') {
    // The task-first kanban home (D1) — work items projected onto the 5 lanes.
    return { status: 200, body: buildBoard(repoRoot) };
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

/**
 * Handles `GET /api/work-items/:key` (async — the local provider reads the item
 * off disk). Replies 400 for a malformed key, 404 when the item is unknown.
 */
async function handleWorkItem(repoRoot: string, key: string, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!WORK_ITEM_KEY.test(key)) {
    send(400, { error: 'invalid work item key' });
    return;
  }
  let detail;
  try {
    detail = await buildWorkItemDetail(repoRoot, key);
  } catch (error) {
    send(500, { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (detail === null) {
    send(404, { error: `work item ${key} not found` });
    return;
  }
  send(200, detail);
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

/** Reads a JSON request body (capped at 1 MiB); `{}` for an empty body. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const value: unknown = JSON.parse(text);
        resolve(
          typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {},
        );
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Handles the POST write surface (start/cancel/approve). 403 when write is disabled. */
async function handleWrite(
  options: ServeOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (options.write === undefined) {
    send(403, { error: 'write surface disabled — start the server with `serve --write`' });
    return;
  }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (path === '/api/runs') {
      const body = await readJsonBody(req);
      const task = typeof body['task'] === 'string' ? body['task'].trim() : '';
      if (task.length === 0) {
        send(400, { error: 'a non-empty "task" is required' });
        return;
      }
      const workItemId = typeof body['workItemId'] === 'string' ? body['workItemId'] : undefined;
      if (workItemId !== undefined && !WORK_ITEM_KEY.test(workItemId)) {
        send(400, { error: 'invalid workItemId' });
        return;
      }
      const out = await options.write.startRun({
        task,
        ...(typeof body['workflow'] === 'string' ? { workflow: body['workflow'] } : {}),
        ...(typeof body['autonomyLevel'] === 'number'
          ? { autonomyLevel: body['autonomyLevel'] }
          : {}),
        ...(typeof body['executionStyle'] === 'string'
          ? { executionStyle: body['executionStyle'] }
          : {}),
        ...(workItemId !== undefined ? { workItemId } : {}),
      });
      send(201, out);
      return;
    }
    // D2: move a work item to another lane (drag-to-change-status).
    const moveMatch = /^\/api\/work-items\/([^/]+)\/move$/.exec(path);
    if (moveMatch !== null) {
      const key = decodeURIComponent(moveMatch[1] as string);
      if (!WORK_ITEM_KEY.test(key)) {
        send(400, { error: 'invalid work item key' });
        return;
      }
      const body = await readJsonBody(req);
      const lane = typeof body['lane'] === 'string' ? body['lane'] : '';
      try {
        send(200, moveWorkItemLane(options.repoRoot, key, lane));
      } catch (error) {
        if (error instanceof InvalidLaneError) {
          send(400, { error: error.message });
        } else {
          send(404, { error: `work item ${key} not found` });
        }
      }
      return;
    }
    const match = /^\/api\/runs\/([^/]+)\/(cancel|approve)$/.exec(path);
    if (match !== null) {
      const id = decodeURIComponent(match[1] as string);
      if (!RUN_ID.test(id)) {
        send(400, { error: 'invalid run id' });
        return;
      }
      if (match[2] === 'cancel') {
        send(200, { cancelled: options.write.cancel(id) });
        return;
      }
      const body = await readJsonBody(req);
      if (typeof body['decision'] !== 'boolean') {
        send(400, { error: 'a boolean "decision" is required' });
        return;
      }
      send(200, { ok: options.write.approve(id, body['decision']) });
      return;
    }
    send(404, { error: 'not found' });
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Builds the token-gated Excalibur HTTP/SSE server (read-only, or +write surface). */
export function createExcaliburServer(options: ServeOptions): Server {
  const pollMs = options.pollMs ?? 500;
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (tokenOf(req, url) !== options.token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized — pass ?token= or Authorization: Bearer' }));
      return;
    }
    // Mutations go through the POST write surface (start/cancel/approve runs).
    if (req.method === 'POST') {
      void handleWrite(options, req, res, url);
      return;
    }
    // The work-item detail is async (reads the item off disk), so it is handled
    // ahead of the synchronous router.
    const wiMatch = WORK_ITEM_PATH.exec(url.pathname.replace(/\/+$/, ''));
    if (wiMatch !== null) {
      void handleWorkItem(options.repoRoot, decodeURIComponent(wiMatch[1] as string), res);
      return;
    }
    let result: Json | Html | 'sse' | null;
    try {
      result = route(options.repoRoot, url, options.write !== undefined);
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
      // Extract the id from the SAME normalized path route() matched on — using
      // the raw pathname would miss a trailing slash and yield an empty id.
      const normalized = url.pathname.replace(/\/+$/, '');
      const id = decodeURIComponent(/\/api\/runs\/([^/]+)\/stream$/.exec(normalized)?.[1] ?? '');
      if (id.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid run id' }));
        return;
      }
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
