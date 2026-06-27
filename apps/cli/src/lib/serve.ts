import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { collectInsights, RunManager } from '@excalibur/core';
import { reduceRail } from '@excalibur/tui';
import { dashboardAppHtml, dashboardNotBuiltHtml } from './dashboard-app';
import {
  buildBoard,
  buildOrchestrations,
  buildWorkItemDetail,
  buildPlans,
  buildPlanDetail,
  buildSprints,
  buildSprintDetail,
  buildDiscovery,
  buildSessions,
  buildSessionDetail,
  buildSchedules,
  buildThreads,
  moveWorkItemLane,
  createWorkItemFrom,
  updateWorkItemFrom,
  deleteWorkItemAt,
  addCommentTo,
  mutateChecklistOn,
  InvalidLaneError,
  InvalidWorkItemError,
  type WorkItemWriteInput,
} from './dashboard-data';
import type { PlanShapeView, ScheduleJobView, ScopeMapView } from '@excalibur/shared';
import { buildChronogramForRun } from './chronogram';
import { missionsList, missionDetail } from './missions-serve';
import { cancelOrchestrationLane, setOrchestrationPaused } from './orchestration-manifest';

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
  /** Plan-shaping proposal for a task (D — dashboard "shape & start" panel). */
  shapePlan(task: string): Promise<PlanShapeView>;
  /** Read-only "Understand-first" scope of a task (AO9-4 — dashboard Scope view).
   * A model compute, no writes; null when no model is configured. */
  scope(task: string): Promise<ScopeMapView | null>;
  /** DASH2 — add a scheduled job from a human cadence + task; the new list, or
   * null when the cadence can't be parsed. */
  scheduleAdd(cadence: string, task: string): ScheduleJobView[] | null;
  /** DASH2 — remove a scheduled job by id; false if unknown. */
  scheduleRemove(id: string): boolean;
  /** DASH2 — enable/disable a scheduled job by id; false if unknown. */
  scheduleSetEnabled(id: string, enabled: boolean): boolean;
}

export interface ServeOptions {
  repoRoot: string;
  /** Shared secret required on every request (`?token=` or `Authorization: Bearer`). */
  token: string;
  /** Injectable clock for the SSE poll loop (tests). */
  pollMs?: number;
  /** When set, enables the POST write surface (start/cancel/approve runs). */
  write?: ServeWriteHandler;
  /**
   * Optional READ-ONLY share token (D5). A request authenticated with it can GET
   * everything but is ALWAYS refused the write surface (403), even when `write`
   * is enabled — so a shared link can never mutate. `excalibur serve --share`
   * mints one and prints a shareable URL.
   */
  shareToken?: string;
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

/**
 * Rejects an id that, used as a directory name, could traverse out of its store
 * folder. The WHATWG URL parser leaves `%2F` / `%2e%2e` percent-encoded in
 * `pathname`, so a `([^/]+)` route capture matches `..%2F..%2Fsecret`, which
 * `decodeURIComponent` then turns into `../../secret`. Any id reaching the
 * filesystem (sessions / plans / missions detail readers) is checked through
 * this first — a stored id never legitimately contains a separator or `..`.
 */
function isTraversalId(id: string): boolean {
  return id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0');
}

/** Extracts the bearer/query token from a request. */
function tokenOf(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return url.searchParams.get('token');
}

/** Constant-time token comparison (no timing side-channel on the secret). */
function tokenMatches(presented: string | null, secret: string | undefined): boolean {
  if (presented === null || secret === undefined) {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cap on simultaneously-open SSE streams (anti-resource-exhaustion). */
const MAX_OPEN_STREAMS = 64;

type RouteResult =
  | Json
  | Html
  | 'sse'
  | 'sse-board'
  | 'sse-orchestration'
  | 'sse-orchestrations'
  | null;

/** Routes a request to a payload, an HTML page, or an SSE sentinel. */
function route(repoRoot: string, url: URL, writable: boolean): RouteResult {
  const manager = new RunManager(repoRoot);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/') {
    // Serve the embedded Svelte work-item dashboard. If it genuinely isn't built
    // (dev before `pnpm -r build`), show an honest "not built" page — never a
    // different, misleading dashboard.
    return { status: 200, html: dashboardAppHtml() ?? dashboardNotBuiltHtml() };
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
  if (path === '/api/orchestrations') {
    // AO4e: parallel orchestrations (parent swarm run + its lane child runs).
    return { status: 200, body: { orchestrations: buildOrchestrations(repoRoot) } };
  }
  if (path === '/api/orchestrations/stream') {
    // AO4e-3: push the orchestrations LIST on change (was a 3s client poll).
    return 'sse-orchestrations';
  }
  const orchMatch = /^\/api\/orchestrations\/([^/]+)(\/stream)?$/.exec(path);
  if (orchMatch !== null) {
    // AO6 Pillar 2: the chronogram detail — the wave/DAG timeline of one swarm.
    const id = decodeURIComponent(orchMatch[1] as string);
    if (!RUN_ID.test(id)) {
      return { status: 400, body: { error: 'invalid run id' } };
    }
    if (orchMatch[2] === '/stream') {
      return 'sse-orchestration'; // push the chronogram on change (live wave/DAG fill)
    }
    const detail = buildChronogramForRun(repoRoot, id);
    return detail === null
      ? { status: 404, body: { error: 'orchestration not found' } }
      : { status: 200, body: detail };
  }
  if (path === '/api/board') {
    // The task-first kanban home (D1) — work items projected onto the 5 lanes.
    return { status: 200, body: buildBoard(repoRoot) };
  }
  if (path === '/api/board/stream') {
    return 'sse-board'; // D5: push board snapshots on change (drops the client poll)
  }
  if (path === '/api/plans') {
    return { status: 200, body: { plans: buildPlans(repoRoot) } }; // D3
  }
  if (path === '/api/discovery') {
    return { status: 200, body: { discovery: buildDiscovery(repoRoot) } }; // D3
  }
  const planMatch = /^\/api\/plans\/([^/]+)$/.exec(path);
  if (planMatch !== null) {
    const id = decodeURIComponent(planMatch[1] as string);
    if (isTraversalId(id)) {
      return { status: 400, body: { error: 'invalid plan id' } };
    }
    const detail = buildPlanDetail(repoRoot, id);
    return detail === null
      ? { status: 404, body: { error: 'plan not found' } }
      : { status: 200, body: detail };
  }
  if (path === '/api/sprints') {
    return { status: 200, body: { sprints: buildSprints(repoRoot) } }; // PLAN5
  }
  const sprintMatch = /^\/api\/sprints\/([^/]+)$/.exec(path);
  if (sprintMatch !== null) {
    const id = decodeURIComponent(sprintMatch[1] as string);
    if (isTraversalId(id)) {
      return { status: 400, body: { error: 'invalid sprint id' } };
    }
    const detail = buildSprintDetail(repoRoot, id);
    return detail === null
      ? { status: 404, body: { error: 'sprint not found' } }
      : { status: 200, body: detail };
  }
  if (path === '/api/sessions') {
    // DASH1: interactive shell sessions — read-only from .excalibur/sessions/.
    return { status: 200, body: { sessions: buildSessions(repoRoot) } };
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch !== null) {
    const id = decodeURIComponent(sessionMatch[1] as string);
    if (isTraversalId(id)) {
      return { status: 400, body: { error: 'invalid session id' } };
    }
    const detail = buildSessionDetail(repoRoot, id);
    return detail === null
      ? { status: 404, body: { error: 'session not found' } }
      : { status: 200, body: detail };
  }
  if (path === '/api/schedules') {
    // DASH2: scheduled autonomous jobs (AO8-3) — read-only from .excalibur/schedules.json.
    return { status: 200, body: { schedules: buildSchedules(repoRoot) } };
  }
  if (path === '/api/threads') {
    // DASH3: the background fleet (`/bg` runs) — read-only projection of the run store.
    return { status: 200, body: { threads: buildThreads(repoRoot) } };
  }
  if (path === '/api/missions') {
    // The meta-orchestrator's missions (M8 #43) — read-only from .excalibur/missions/.
    return { status: 200, body: { missions: missionsList(repoRoot) } };
  }
  const missionMatch = /^\/api\/missions\/([^/]+)$/.exec(path);
  if (missionMatch !== null) {
    const id = decodeURIComponent(missionMatch[1] as string);
    if (isTraversalId(id)) {
      return { status: 400, body: { error: 'invalid mission id' } };
    }
    const detail = missionDetail(repoRoot, id);
    return detail === null
      ? { status: 404, body: { error: 'mission not found' } }
      : { status: 200, body: detail };
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

/**
 * Streams the kanban board as SSE (D5): emit the current snapshot immediately,
 * then re-evaluate on an interval and push only when it CHANGED (hash compare) —
 * server-side polling so the browser drops its own poll. A periodic comment line
 * keeps the connection alive through proxies.
 */
function streamBoard(repoRoot: string, res: ServerResponse, pollMs: number): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let last = '';
  let beats = 0;
  const tick = (): void => {
    let snapshot: string;
    try {
      snapshot = JSON.stringify(buildBoard(repoRoot));
    } catch {
      return; // a transient read error — try again next tick
    }
    if (snapshot !== last) {
      last = snapshot;
      res.write(`event: board\ndata: ${snapshot}\n\n`);
    } else if ((beats += 1) % 10 === 0) {
      res.write(': keep-alive\n\n'); // comment frame, ignored by EventSource
    }
  };
  tick();
  const timer = setInterval(tick, Math.max(250, pollMs));
  timer.unref?.();
  res.on('close', () => clearInterval(timer));
}

/**
 * AO4e-3 — streams the orchestrations LIST as SSE: emit the current set, then push
 * a new snapshot only when it CHANGES (a lane finished, a swarm started, a lane was
 * cancelled). Replaces the dashboard's 3s poll. Mirrors {@link streamBoard}.
 */
function streamOrchestrations(repoRoot: string, res: ServerResponse, pollMs: number): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let last = '';
  let beats = 0;
  const tick = (): void => {
    let snapshot: string;
    try {
      snapshot = JSON.stringify({ orchestrations: buildOrchestrations(repoRoot) });
    } catch {
      return; // a transient read error — try again next tick
    }
    if (snapshot !== last) {
      last = snapshot;
      res.write(`event: orchestrations\ndata: ${snapshot}\n\n`);
    } else if ((beats += 1) % 10 === 0) {
      res.write(': keep-alive\n\n');
    }
  };
  tick();
  const timer = setInterval(tick, Math.max(250, pollMs));
  timer.unref?.();
  res.on('close', () => clearInterval(timer));
}

/**
 * Streams ONE orchestration's chronogram as SSE (AO6 Pillar 2): emit the current
 * wave/DAG snapshot immediately, then re-evaluate on an interval and push only
 * when it CHANGED — so the dashboard timeline fills wave-by-wave live without a
 * client poll. Mirrors {@link streamBoard}. A transient build error skips a tick.
 */
function streamChronogram(repoRoot: string, id: string, res: ServerResponse, pollMs: number): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let last = '';
  let beats = 0;
  const tick = (): void => {
    let snapshot: string;
    try {
      const dto = buildChronogramForRun(repoRoot, id);
      if (dto === null) return; // not (yet) an orchestration — try again next tick
      snapshot = JSON.stringify(dto);
    } catch {
      return;
    }
    if (snapshot !== last) {
      last = snapshot;
      res.write(`event: orchestration\ndata: ${snapshot}\n\n`);
    } else if ((beats += 1) % 10 === 0) {
      res.write(': keep-alive\n\n');
    }
  };
  tick();
  const timer = setInterval(tick, Math.max(250, pollMs));
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

/** Coerces a JSON body into the work-item write fields, dropping anything mistyped. */
function parseWorkItemBody(body: Record<string, unknown>): WorkItemWriteInput {
  const out: WorkItemWriteInput = {};
  if (typeof body['title'] === 'string') out.title = body['title'];
  if (typeof body['description'] === 'string' || body['description'] === null) {
    out.description = body['description'] as string | null;
  }
  if (Array.isArray(body['labels'])) {
    out.labels = (body['labels'] as unknown[]).filter((l): l is string => typeof l === 'string');
  }
  if (typeof body['priority'] === 'string' || body['priority'] === null) {
    out.priority = body['priority'] as string | null;
  }
  if (typeof body['lane'] === 'string') out.lane = body['lane'];
  if (typeof body['assignee'] === 'string' || body['assignee'] === null) {
    out.assignee = body['assignee'] as string | null;
  }
  return out;
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
    // D: plan-shaping — propose clarifying questions + scope recommendations for
    // a task BEFORE starting a run (a model compute, not a mutation, but it needs
    // the configured model so it lives on the write surface).
    if (path === '/api/plan-shape') {
      const body = await readJsonBody(req);
      const task = typeof body['task'] === 'string' ? body['task'].trim() : '';
      if (task.length === 0) {
        send(400, { error: 'a non-empty "task" is required' });
        return;
      }
      send(200, await options.write.shapePlan(task));
      return;
    }
    // AO9-4: read-only "Understand-first" scope of a task for the dashboard Scope
    // view — a model compute (no mutation), but it needs the configured model so,
    // like plan-shape, it lives on the write surface. Returns a ScopeMap | null.
    if (path === '/api/scope') {
      const body = await readJsonBody(req);
      const task = typeof body['task'] === 'string' ? body['task'].trim() : '';
      if (task.length === 0) {
        send(400, { error: 'a non-empty "task" is required' });
        return;
      }
      send(200, await options.write.scope(task));
      return;
    }
    // DASH2: scheduler CRUD on the write surface (store-only; no model needed).
    if (path === '/api/schedules') {
      const body = await readJsonBody(req);
      const cadence = typeof body['cadence'] === 'string' ? body['cadence'].trim() : '';
      const task = typeof body['task'] === 'string' ? body['task'].trim() : '';
      if (cadence.length === 0 || task.length === 0) {
        send(400, { error: 'both "cadence" and "task" are required' });
        return;
      }
      const schedules = options.write.scheduleAdd(cadence, task);
      if (schedules === null) {
        send(400, { error: `could not parse cadence "${cadence}"` });
        return;
      }
      send(201, { schedules });
      return;
    }
    const schedToggle = /^\/api\/schedules\/([^/]+)\/toggle$/.exec(path);
    if (schedToggle !== null) {
      const body = await readJsonBody(req);
      const enabled = body['enabled'] === true;
      const ok = options.write.scheduleSetEnabled(
        decodeURIComponent(schedToggle[1] as string),
        enabled,
      );
      send(ok ? 200 : 404, ok ? { ok: true, enabled } : { error: 'schedule not found' });
      return;
    }
    const schedRemove = /^\/api\/schedules\/([^/]+)\/remove$/.exec(path);
    if (schedRemove !== null) {
      const ok = options.write.scheduleRemove(decodeURIComponent(schedRemove[1] as string));
      send(ok ? 200 : 404, ok ? { ok: true } : { error: 'schedule not found' });
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
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof InvalidLaneError) {
          send(400, { error: message });
        } else if (/not found/i.test(message)) {
          send(404, { error: `work item ${key} not found` });
        } else {
          // A corrupt/unreadable work-item file is a server error, not a 404.
          send(500, { error: message });
        }
      }
      return;
    }
    // Create a work item (the dashboard "+ New" / quick-add).
    if (path === '/api/work-items') {
      const body = await readJsonBody(req);
      try {
        send(201, createWorkItemFrom(options.repoRoot, parseWorkItemBody(body)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const bad = error instanceof InvalidWorkItemError || error instanceof InvalidLaneError;
        send(bad ? 400 : 500, { error: message });
      }
      return;
    }
    // Delete a work item.
    const wiDelete = /^\/api\/work-items\/([^/]+)\/delete$/.exec(path);
    if (wiDelete !== null) {
      const key = decodeURIComponent(wiDelete[1] as string);
      if (!WORK_ITEM_KEY.test(key)) {
        send(400, { error: 'invalid work item key' });
        return;
      }
      const ok = deleteWorkItemAt(options.repoRoot, key);
      send(ok ? 200 : 404, ok ? { deleted: true } : { error: `work item ${key} not found` });
      return;
    }
    // Add a comment to a work item.
    const wiComment = /^\/api\/work-items\/([^/]+)\/comment$/.exec(path);
    if (wiComment !== null) {
      const key = decodeURIComponent(wiComment[1] as string);
      if (!WORK_ITEM_KEY.test(key)) {
        send(400, { error: 'invalid work item key' });
        return;
      }
      const body = await readJsonBody(req);
      const text = typeof body['body'] === 'string' ? body['body'] : '';
      try {
        const detail = await addCommentTo(options.repoRoot, key, text);
        send(detail !== null ? 200 : 404, detail ?? { error: `work item ${key} not found` });
      } catch (error) {
        send(400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // Add / toggle / remove a user-authored checklist item.
    const wiChecklist = /^\/api\/work-items\/([^/]+)\/checklist$/.exec(path);
    if (wiChecklist !== null) {
      const key = decodeURIComponent(wiChecklist[1] as string);
      if (!WORK_ITEM_KEY.test(key)) {
        send(400, { error: 'invalid work item key' });
        return;
      }
      const body = await readJsonBody(req);
      const action = body['action'];
      let op:
        | { action: 'add'; text: string }
        | { action: 'toggle'; id: string }
        | { action: 'remove'; id: string }
        | null = null;
      if (action === 'add' && typeof body['text'] === 'string') {
        op = { action: 'add', text: body['text'] };
      } else if ((action === 'toggle' || action === 'remove') && typeof body['id'] === 'string') {
        op = { action, id: body['id'] };
      }
      if (op === null) {
        send(400, { error: 'invalid checklist op' });
        return;
      }
      const detail = await mutateChecklistOn(options.repoRoot, key, op);
      send(detail !== null ? 200 : 404, detail ?? { error: `work item ${key} not found` });
      return;
    }
    // Edit a work item's fields (bare :key — MUST follow the subroutes above).
    const wiEdit = /^\/api\/work-items\/([^/]+)$/.exec(path);
    if (wiEdit !== null) {
      const key = decodeURIComponent(wiEdit[1] as string);
      if (!WORK_ITEM_KEY.test(key)) {
        send(400, { error: 'invalid work item key' });
        return;
      }
      const body = await readJsonBody(req);
      try {
        const detail = await updateWorkItemFrom(options.repoRoot, key, parseWorkItemBody(body));
        send(detail !== null ? 200 : 404, detail ?? { error: `work item ${key} not found` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const bad = error instanceof InvalidWorkItemError || error instanceof InvalidLaneError;
        send(bad ? 400 : 500, { error: message });
      }
      return;
    }
    // AO6 Pillar 3: pause / resume an orchestration mid-flight (toggle the
    // control flag a live swarm's lane gate polls). A mutation → write surface.
    const pauseMatch = /^\/api\/orchestrations\/([^/]+)\/pause$/.exec(path);
    if (pauseMatch !== null) {
      const id = decodeURIComponent(pauseMatch[1] as string);
      if (!RUN_ID.test(id)) {
        send(400, { error: 'invalid run id' });
        return;
      }
      const body = await readJsonBody(req);
      const paused = body['paused'] === true;
      const ok = setOrchestrationPaused(options.repoRoot, id, paused, new Date().toISOString());
      if (ok) {
        send(200, { paused });
      } else {
        send(404, { error: 'orchestration not found' });
      }
      return;
    }
    // AO4e-3: cancel ONE lane of a live orchestration (skip it if not started;
    // an in-flight lane finishes, as with pause). A mutation → write surface.
    const laneCancelMatch = /^\/api\/orchestrations\/([^/]+)\/lanes\/([^/]+)\/cancel$/.exec(path);
    if (laneCancelMatch !== null) {
      const parentId = decodeURIComponent(laneCancelMatch[1] as string);
      const laneRunId = decodeURIComponent(laneCancelMatch[2] as string);
      if (!RUN_ID.test(parentId) || !RUN_ID.test(laneRunId)) {
        send(400, { error: 'invalid run id' });
        return;
      }
      const ok = cancelOrchestrationLane(options.repoRoot, parentId, laneRunId);
      if (ok) {
        send(200, { cancelled: true });
      } else {
        send(404, { error: 'orchestration not found' });
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
  let openStreams = 0; // bounded so a client can't exhaust fds via SSE
  /** Run an SSE handler under the open-stream cap; 503 when exceeded. */
  const withStreamCap = (res: ServerResponse, run: () => void): void => {
    if (openStreams >= MAX_OPEN_STREAMS) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too many open streams' }));
      return;
    }
    openStreams += 1;
    res.on('close', () => {
      openStreams -= 1;
    });
    run();
  };
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const presented = tokenOf(req, url);
    const isPrimary = tokenMatches(presented, options.token);
    const isShare = !isPrimary && tokenMatches(presented, options.shareToken);
    if (!isPrimary && !isShare) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized — pass ?token= or Authorization: Bearer' }));
      return;
    }
    // Mutations go through the POST write surface (start/cancel/approve runs).
    // The read-only SHARE token can never mutate — refuse before doing any work.
    if (req.method === 'POST') {
      if (isShare) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'read-only share link — mutations are disabled' }));
        return;
      }
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
    let result: RouteResult;
    try {
      // A share-token viewer must see write:false so the UI hides its actions.
      result = route(options.repoRoot, url, options.write !== undefined && !isShare);
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
      withStreamCap(res, () => streamRun(options.repoRoot, id, res, pollMs));
      return;
    }
    if (result === 'sse-board') {
      withStreamCap(res, () => streamBoard(options.repoRoot, res, pollMs));
      return;
    }
    if (result === 'sse-orchestrations') {
      withStreamCap(res, () => streamOrchestrations(options.repoRoot, res, pollMs));
      return;
    }
    if (result === 'sse-orchestration') {
      const normalized = url.pathname.replace(/\/+$/, '');
      const id = decodeURIComponent(
        /\/api\/orchestrations\/([^/]+)\/stream$/.exec(normalized)?.[1] ?? '',
      );
      if (id.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid run id' }));
        return;
      }
      withStreamCap(res, () => streamChronogram(options.repoRoot, id, res, pollMs));
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
