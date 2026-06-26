import { RunManager, listPlans, readPlan, DiscoveryManager, SessionStore } from '@excalibur/core';
import type { LocalRun } from '@excalibur/shared';
import {
  LocalWorkItemProvider,
  isWorkItemLane,
  laneOf,
  WORK_ITEM_LANES,
  WORK_ITEM_LANE_LABELS,
  type NormalizedWorkItem,
  type NormalizedWorkItemUser,
  type WorkItemLane,
} from '@excalibur/work-items';
import {
  DASHBOARD_LANES,
  type BoardResponse,
  type ChecklistItemDto,
  type DashboardBoardLane,
  type DashboardLane,
  type DiscoverySummary,
  type OrchestrationSummary,
  type PlanDetail,
  type PlanSummary,
  type RunSummary,
  type SessionDetail,
  type SessionSummary,
  type WorkItemDetail,
  type WorkItemSummary,
} from '@excalibur/shared';

/**
 * Maps the in-process stores (`@excalibur/work-items` + `RunManager`) onto the
 * dashboard wire DTOs (`@excalibur/shared`). The serve layer routes to these so
 * the HTTP surface stays a thin adapter and the mapping is unit-testable.
 */

// Compile-time guard: the dashboard's lane contract (@excalibur/shared) must
// stay byte-identical to the store's canonical lanes (@excalibur/work-items) —
// same members AND same order. This tuple-equality assertion fails to compile if
// either set drifts in any way (add / remove / rename / REORDER).
type AssertTupleEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _laneParity: AssertTupleEqual<typeof WORK_ITEM_LANES, typeof DASHBOARD_LANES> = true;
void _laneParity;
// Keep the element-type relation referenced so both imports stay load-bearing.
const _laneTypeParity: readonly DashboardLane[] = WORK_ITEM_LANES satisfies readonly WorkItemLane[];
void _laneTypeParity;

/**
 * Whether a link URL is safe to render into an `href`. Blocks `javascript:` /
 * `data:` and other script-bearing schemes (Svelte does NOT sanitize attribute
 * schemes), and protocol-relative `//host` URLs; allows http(s)/mailto, absolute
 * paths and fragments. Applied here so a poisoned `.excalibur/work-items/*.json`
 * (shared/cloned repos) or a remote provider URL can never reach the renderer.
 */
function safeLinkUrl(url: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const cleaned = url.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (/^(https?:|mailto:)/i.test(cleaned)) return cleaned;
  if (cleaned.startsWith('#')) return cleaned;
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) return cleaned;
  return '#';
}

function userName(user: NormalizedWorkItemUser | null): string | null {
  if (user === null) {
    return null;
  }
  return user.name ?? user.username ?? null;
}

/** A run is "active" (in flight) when it is running or awaiting an approval. */
function isActiveRun(run: LocalRun): boolean {
  return run.record.status === 'running' || run.record.status === 'waiting_approval';
}

/**
 * The active run's latest `update_tasks` checklist (last snapshot wins), read
 * from its event log. Empty when there is no active run or no checklist yet —
 * never throws (a missing/corrupt log just yields []).
 */
function activeChecklist(
  runs: LocalRun[],
  manager: RunManager,
): { activeRunId: string | null; checklist: ChecklistItemDto[] } {
  // Newest-first (runsForWorkItem already sorts) → first active run wins.
  const active = runs.find(isActiveRun);
  if (active === undefined) {
    return { activeRunId: null, checklist: [] };
  }
  let checklist: ChecklistItemDto[] = [];
  try {
    const events = manager.readEvents(active.id);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type === 'task_update') {
        const tasks = (event.payload as { tasks?: unknown }).tasks;
        if (Array.isArray(tasks)) {
          checklist = tasks
            .filter((t): t is ChecklistItemDto => {
              const item = t as Partial<ChecklistItemDto>;
              return (
                typeof item.id === 'string' &&
                typeof item.text === 'string' &&
                (item.status === 'pending' ||
                  item.status === 'in_progress' ||
                  item.status === 'completed')
              );
            })
            .map((t) => ({ id: t.id, text: t.text, status: t.status }));
        }
        break; // last task_update snapshot wins
      }
    }
  } catch {
    /* unreadable log → no checklist */
  }
  return { activeRunId: active.record.id, checklist };
}

function summarize(
  item: NormalizedWorkItem,
  runs: LocalRun[],
  manager: RunManager,
): WorkItemSummary {
  const { activeRunId, checklist } = activeChecklist(runs, manager);
  return {
    key: item.key,
    title: item.title,
    status: item.status,
    lane: laneOf(item.status),
    priority: item.priority,
    labels: item.labels,
    assignee: userName(item.assignee),
    runCount: runs.length,
    order: item.order ?? 0,
    updatedAt: item.updatedAt,
    activeRunId,
    checklist,
  };
}

/** Rolls a run + its model-call ledger up into a `RunSummary`. */
function runSummary(run: LocalRun, manager: RunManager): RunSummary {
  const calls = manager.readModelCalls(run.id);
  const hasCost = calls.some((c) => c.costCents !== null && c.costCents !== undefined);
  const sum = (pick: (c: (typeof calls)[number]) => number | null | undefined): number =>
    calls.reduce((acc, c) => acc + (pick(c) ?? 0), 0);
  return {
    id: run.record.id,
    title: run.record.title,
    status: run.record.status,
    workflow: run.record.workflow,
    model: run.record.model,
    startedAt: run.record.startedAt,
    completedAt: run.record.completedAt,
    costCents: hasCost ? sum((c) => c.costCents) : null,
    inputTokens: calls.length > 0 ? sum((c) => c.inputTokens) : null,
    outputTokens: calls.length > 0 ? sum((c) => c.outputTokens) : null,
    workItemId: run.record.workItemId ?? null,
  };
}

/**
 * Projects the run store into parallel ORCHESTRATIONS (AO4e) for
 * `GET /api/orchestrations`: every run that is the PARENT of ≥1 child lane
 * (a run carrying `parentRunId`) becomes a summary with its lanes nested.
 * Newest first. This is what lets the dashboard see the swarm/parallel work
 * that AO4a now persists as parent + child runs.
 */
export function buildOrchestrations(repoRoot: string): OrchestrationSummary[] {
  const manager = new RunManager(repoRoot);
  const runs = manager.listRuns();
  const byId = new Map(runs.map((r) => [r.record.id, r]));
  // Group children by their parent id.
  const childrenByParent = new Map<string, LocalRun[]>();
  for (const run of runs) {
    const parent = run.record.parentRunId;
    if (typeof parent === 'string' && parent.length > 0) {
      const list = childrenByParent.get(parent) ?? [];
      list.push(run);
      childrenByParent.set(parent, list);
    }
  }
  const laneCost = (run: LocalRun): number | null => {
    const calls = manager.readModelCalls(run.record.id);
    return calls.some((c) => c.costCents != null)
      ? calls.reduce((acc, c) => acc + (c.costCents ?? 0), 0)
      : null;
  };
  const summaries: OrchestrationSummary[] = [];
  for (const [parentId, children] of childrenByParent) {
    const parent = byId.get(parentId);
    // A parent run record is normal, but tolerate an orphaned group (parent
    // record missing) by synthesizing from the children.
    const lanes = [...children]
      .sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt))
      .map((c) => ({
        runId: c.record.id,
        title: c.record.title,
        status: c.record.status,
        costCents: laneCost(c),
        // AO4e-3 — surface the lane's work item (live now that SwarmFlowContext
        // threads workItemId → each child run records it).
        workItemId: c.record.workItemId ?? null,
      }));
    summaries.push({
      parentRunId: parentId,
      title: parent?.record.title ?? `orchestration ${parentId}`,
      status: parent?.record.status ?? 'running',
      startedAt: parent?.record.startedAt ?? children[0]?.record.startedAt ?? parentId,
      completedAt: parent?.record.completedAt ?? null,
      workItemId: parent?.record.workItemId ?? null,
      laneCount: lanes.length,
      lanes,
    });
  }
  return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Builds the kanban board DTO for `GET /api/board`. */
export function buildBoard(repoRoot: string): BoardResponse {
  const provider = new LocalWorkItemProvider(repoRoot);
  const manager = new RunManager(repoRoot);
  // Read every run ONCE and bucket by work item, instead of re-scanning all runs
  // per card (`runsForWorkItem` calls `listRuns()` each time → O(items×runs) on
  // every 4s board poll). `listRuns()` is NOT guaranteed newest-first (it sorts
  // by id ascending = oldest-first), so each bucket is sorted newest-first below
  // to match `runsForWorkItem` — the active-run pick depends on that order.
  const runsByItem = new Map<string, LocalRun[]>();
  for (const run of manager.listRuns()) {
    const wid = run.record.workItemId;
    if (wid === null || wid === undefined) continue;
    const bucket = runsByItem.get(wid);
    if (bucket === undefined) runsByItem.set(wid, [run]);
    else bucket.push(run);
  }
  for (const bucket of runsByItem.values()) {
    bucket.sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt)); // newest first
  }
  const lanes: DashboardBoardLane[] = provider.board().map((column) => ({
    lane: column.lane,
    label: WORK_ITEM_LANE_LABELS[column.lane],
    items: column.items.map((item) => summarize(item, runsByItem.get(item.key) ?? [], manager)),
  }));
  return { lanes, generatedAt: new Date().toISOString() };
}

/** Builds the work-item detail DTO for `GET /api/work-items/:key`, or null if absent. */
export async function buildWorkItemDetail(
  repoRoot: string,
  key: string,
): Promise<WorkItemDetail | null> {
  const provider = new LocalWorkItemProvider(repoRoot);
  let item: NormalizedWorkItem;
  try {
    // The local provider ignores integrationId and looks the item up by key.
    item = await provider.getWorkItem({ integrationId: 'local', externalIdOrKey: key });
  } catch {
    return null; // not found (the provider rejects on a missing key)
  }
  const manager = new RunManager(repoRoot);
  const runs = manager.runsForWorkItem(item.key).map((run) => runSummary(run, manager));
  return {
    key: item.key,
    title: item.title,
    description: item.description,
    status: item.status,
    lane: laneOf(item.status),
    priority: item.priority,
    labels: item.labels,
    assignee: userName(item.assignee),
    reporter: userName(item.reporter),
    url: item.url,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    parentKey: item.parentExternalId,
    runs,
    links: item.links.map((l) => ({ type: l.type, url: safeLinkUrl(l.url), title: l.title })),
    comments: item.comments.map((c) => ({
      author: userName(c.author),
      body: c.body,
      createdAt: c.createdAt,
    })),
    // Plans are linked in D3; D0 ships the (empty) contract slot.
    plans: [],
  };
}

/** Raised by {@link moveWorkItemLane} for an invalid target lane (→ 400). */
export class InvalidLaneError extends Error {}

/**
 * Moves a work item to a target lane (D2 drag-to-change-status) and returns the
 * updated card summary. Throws {@link InvalidLaneError} for an unknown lane and
 * re-throws the provider's not-found error for an unknown key.
 */
export function moveWorkItemLane(repoRoot: string, key: string, lane: string): WorkItemSummary {
  if (!isWorkItemLane(lane)) {
    throw new InvalidLaneError(`invalid lane "${lane}"`);
  }
  const provider = new LocalWorkItemProvider(repoRoot);
  const item = provider.moveWorkItem(key, { lane }); // throws if the key is unknown
  const manager = new RunManager(repoRoot);
  return summarize(item, manager.runsForWorkItem(item.key), manager);
}

/** Plans list for the Plans & Discovery view (D3), newest first. */
export function buildPlans(repoRoot: string): PlanSummary[] {
  return listPlans(repoRoot).map((p) => ({
    id: p.id,
    task: p.task,
    status: p.status,
    created: p.created,
    planRun: p.planRun,
    execRun: p.execRun,
  }));
}

/** One plan with its markdown body (D3 drill-in), or null if unknown. */
export function buildPlanDetail(repoRoot: string, id: string): PlanDetail | null {
  const p = readPlan(repoRoot, id);
  if (p === null) {
    return null;
  }
  return {
    id: p.id,
    task: p.task,
    status: p.status,
    created: p.created,
    planRun: p.planRun,
    execRun: p.execRun,
    body: p.body,
  };
}

/** Discovery sessions for the Plans & Discovery view (D3), newest first. */
export function buildDiscovery(repoRoot: string): DiscoverySummary[] {
  return new DiscoveryManager(repoRoot)
    .listSessions()
    .map((s) => ({
      id: s.record.id,
      title: s.record.title,
      status: s.record.status,
      recommendation: s.record.recommendation,
      recommendedAutonomyLevel: s.record.recommendedAutonomyLevel,
      createdAt: s.record.createdAt,
      completedAt: s.record.completedAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Shell sessions for the dashboard Sessions list (DASH1), newest-updated first. */
export function buildSessions(repoRoot: string): SessionSummary[] {
  return new SessionStore(repoRoot)
    .listSessions()
    .map((s) => sessionSummaryOf(s.metadata))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** One session with its full transcript (DASH1 drill-in), or null if unknown. */
export function buildSessionDetail(repoRoot: string, id: string): SessionDetail | null {
  const store = new SessionStore(repoRoot);
  let session;
  try {
    session = store.getSession(id);
  } catch {
    return null; // unknown / corrupt session id
  }
  return {
    ...sessionSummaryOf(session.metadata),
    turns: store.readTranscript(id).map((turn) => ({
      id: turn.id,
      seq: turn.seq,
      role: turn.role,
      kind: turn.kind,
      text: turn.text,
      ...(turn.route !== undefined ? { route: turn.route } : {}),
      ...(turn.model !== undefined ? { model: turn.model } : {}),
      ...(turn.costCents !== undefined ? { costCents: turn.costCents } : {}),
      at: turn.at,
    })),
  };
}

/** Projects core SessionMetadata onto the wire SessionSummary. */
function sessionSummaryOf(m: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastModel: string | null;
  turnCount: number;
  status: 'active' | 'closed';
}): SessionSummary {
  return {
    id: m.id,
    title: m.title,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    lastModel: m.lastModel,
    turnCount: m.turnCount,
    status: m.status,
  };
}
