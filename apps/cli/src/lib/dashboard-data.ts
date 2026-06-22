import { RunManager } from '@excalibur/core';
import type { LocalRun } from '@excalibur/shared';
import {
  LocalWorkItemProvider,
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
  type RunSummary,
  type WorkItemDetail,
  type WorkItemSummary,
} from '@excalibur/shared';

/**
 * Maps the in-process stores (`@excalibur/work-items` + `RunManager`) onto the
 * dashboard wire DTOs (`@excalibur/shared`). The serve layer routes to these so
 * the HTTP surface stays a thin adapter and the mapping is unit-testable.
 */

// Compile-time guard: the dashboard's lane contract (@excalibur/shared) must
// stay byte-identical to the store's canonical lanes (@excalibur/work-items).
// If either drifts, one of these assignments stops type-checking.
const _laneParity: readonly DashboardLane[] = WORK_ITEM_LANES;
const _laneParityReverse: readonly WorkItemLane[] = DASHBOARD_LANES;
void _laneParity;
void _laneParityReverse;

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

/** Builds the kanban board DTO for `GET /api/board`. */
export function buildBoard(repoRoot: string): BoardResponse {
  const provider = new LocalWorkItemProvider(repoRoot);
  const manager = new RunManager(repoRoot);
  const lanes: DashboardBoardLane[] = provider.board().map((column) => ({
    lane: column.lane,
    label: WORK_ITEM_LANE_LABELS[column.lane],
    items: column.items.map((item) => summarize(item, manager.runsForWorkItem(item.key), manager)),
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
    links: item.links.map((l) => ({ type: l.type, url: l.url, title: l.title })),
    comments: item.comments.map((c) => ({
      author: userName(c.author),
      body: c.body,
      createdAt: c.createdAt,
    })),
    // Plans are linked in D3; D0 ships the (empty) contract slot.
    plans: [],
  };
}
