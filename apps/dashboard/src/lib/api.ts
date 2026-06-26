/**
 * Typed API client for the dashboard. Talks to the same `excalibur serve`
 * instance that served this page, reusing the per-process token carried in the
 * page URL (`?token=…`) — exactly how the legacy dashboard authenticated. Every
 * response is typed against the shared dashboard contracts.
 */
import type {
  BoardResponse,
  ChronogramDto,
  DashboardLane,
  DiscoverySummary,
  InsightsReportDto,
  OrchestrationSummary,
  PlanDetail,
  PlanShapeView,
  PlanSummary,
  RunRecord,
  ScheduleJobView,
  ScopeMapView,
  SessionDetail,
  SessionSummary,
  WorkItemDetail,
  WorkItemSummary,
} from './contracts';

/** The token the server embedded in this page's URL (query or hash). */
function authToken(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  if (fromQuery !== null && fromQuery.length > 0) {
    return fromQuery;
  }
  // Hash router keeps `#/path`; a token may live before the hash only, but guard
  // a `?token=` that ended up in the hash fragment too.
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  if (q !== -1) {
    const t = new URLSearchParams(hash.slice(q + 1)).get('token');
    if (t !== null && t.length > 0) {
      return t;
    }
  }
  return '';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${authToken()}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') {
        detail = body.error;
      }
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authToken()}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const b = (await res.json()) as { error?: string };
      if (typeof b.error === 'string') detail = b.error;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

/** Health probe — `write` reports whether the interactive surface is enabled (D2). */
export const fetchHealth = (): Promise<{
  ok: boolean;
  service: string;
  repoRoot: string;
  write: boolean;
}> => get('/health');

/** The kanban board (D1). */
export const fetchBoard = (): Promise<BoardResponse> => get('/api/board');

/** A work item with its linked runs / PRs / plans (D1/D2/D3). */
export const fetchWorkItem = (key: string): Promise<WorkItemDetail> =>
  get(`/api/work-items/${encodeURIComponent(key)}`);

/** All runs (the runs explorer). `/api/runs` returns full RunRecords today; the
 * explorer reads a subset. D4 will switch this to rolled-up RunSummary objects. */
export const fetchRuns = (): Promise<{ runs: RunRecord[] }> => get('/api/runs');

/** Aggregate insights for the analytics view (D4). */
export const fetchInsights = (): Promise<InsightsReportDto> => get('/api/insights');

/** Parallel orchestrations — parent swarm runs + their lane children (AO4e). */
export const fetchOrchestrations = (): Promise<{ orchestrations: OrchestrationSummary[] }> =>
  get('/api/orchestrations');

/** One orchestration's chronogram — the wave/DAG timeline DTO (AO6 Pillar 2). */
export const fetchChronogram = (id: string): Promise<ChronogramDto> =>
  get(`/api/orchestrations/${encodeURIComponent(id)}`);

/** Saved plans (D3). */
export const fetchPlans = (): Promise<{ plans: PlanSummary[] }> => get('/api/plans');

/** One plan with its markdown body (D3). */
export const fetchPlan = (id: string): Promise<PlanDetail> =>
  get(`/api/plans/${encodeURIComponent(id)}`);

/** Discovery sessions (D3). */
export const fetchDiscovery = (): Promise<{ discovery: DiscoverySummary[] }> =>
  get('/api/discovery');

/** Interactive shell sessions (DASH1) — read-only list, newest-updated first. */
export const fetchSessions = (): Promise<{ sessions: SessionSummary[] }> => get('/api/sessions');

/** One session with its full transcript (DASH1 drill-in). */
export const fetchSession = (id: string): Promise<SessionDetail> =>
  get(`/api/sessions/${encodeURIComponent(id)}`);

/** Scheduled autonomous jobs (DASH2) — read-only list, soonest-next first. */
export const fetchSchedules = (): Promise<{ schedules: ScheduleJobView[] }> =>
  get('/api/schedules');

/** Add a scheduled job from a human cadence + task (DASH2; write surface). */
export const addSchedule = (
  cadence: string,
  task: string,
): Promise<{ schedules: ScheduleJobView[] }> => post('/api/schedules', { cadence, task });

/** Enable / disable a scheduled job (DASH2; write surface). */
export const toggleSchedule = (id: string, enabled: boolean): Promise<{ ok: boolean }> =>
  post(`/api/schedules/${encodeURIComponent(id)}/toggle`, { enabled });

/** Remove a scheduled job (DASH2; write surface). */
export const removeSchedule = (id: string): Promise<{ ok: boolean }> =>
  post(`/api/schedules/${encodeURIComponent(id)}/remove`, {});

// ---- meta-orchestrator missions (M8 #43) — read-only view of .excalibur/missions/ ----

/** One mission summary for the list view. */
export interface MissionListItemView {
  id: string;
  goal: string;
  outcome: string;
  spentCents: number;
  stepsDone: number;
  stepsTotal: number;
}
/** One step of a mission's capability DAG. */
export interface MissionStepView {
  id: string;
  capability: string;
  objective: string;
  status: string;
  gate: boolean;
  attempts: number;
  dependsOn: string[];
}
/** A mission's full DAG + progress for the detail view. */
export interface MissionDetailView {
  id: string;
  goal: string;
  interpretation: string;
  complexity: string;
  risk: string;
  outcome: string;
  pausedReason?: string;
  spentCents: number;
  successCriteria: string[];
  steps: MissionStepView[];
}

/** All checkpointed missions (the meta-orchestrator runs). */
export const fetchMissions = (): Promise<{ missions: MissionListItemView[] }> =>
  get('/api/missions');

/** One mission's full capability DAG + progress. */
export const fetchMission = (id: string): Promise<MissionDetailView> =>
  get(`/api/missions/${encodeURIComponent(id)}`);

// ---- write surface (D2; only succeeds when `excalibur serve --write`) ----

/** Move a work item to another lane (drag-to-change-status). Returns the updated card. */
export const moveWorkItem = (key: string, lane: DashboardLane): Promise<WorkItemSummary> =>
  post(`/api/work-items/${encodeURIComponent(key)}/move`, { lane });

/** Start a run, optionally linked to a work item. */
export const startRun = (input: {
  task: string;
  workItemId?: string;
}): Promise<{ runId: string }> => post('/api/runs', input);

/** Plan-shaping proposal for a task — clarifying questions + scope recs (D). */
export const shapePlan = (task: string): Promise<PlanShapeView> =>
  post('/api/plan-shape', { task });

/** Read-only "Understand-first" scope of a task — subsystems, built-vs-missing,
 * risks (AO9-4). Returns null when no model is configured. */
export const fetchScope = (task: string): Promise<ScopeMapView | null> =>
  post('/api/scope', { task });

/** Cancel a run. */
export const cancelRun = (id: string): Promise<{ cancelled: boolean }> =>
  post(`/api/runs/${encodeURIComponent(id)}/cancel`, {});

/** Answer a run's pending approval. */
export const approveRun = (id: string, decision: boolean): Promise<{ ok: boolean }> =>
  post(`/api/runs/${encodeURIComponent(id)}/approve`, { decision });

/** Pause / resume an orchestration mid-flight (AO6 Pillar 3). */
export const pauseOrchestration = (id: string, paused: boolean): Promise<{ paused: boolean }> =>
  post(`/api/orchestrations/${encodeURIComponent(id)}/pause`, { paused });

/** Cancel ONE lane (its child run) of a live orchestration (AO4e-3). */
export const cancelOrchestrationLane = (
  parentId: string,
  laneRunId: string,
): Promise<{ cancelled: boolean }> =>
  post(
    `/api/orchestrations/${encodeURIComponent(parentId)}/lanes/${encodeURIComponent(laneRunId)}/cancel`,
    {},
  );

export { authToken };
