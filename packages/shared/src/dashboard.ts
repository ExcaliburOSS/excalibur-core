/**
 * Dashboard data contracts (D0 — task-first information architecture).
 *
 * These are the wire shapes the OSS web dashboard consumes from `excalibur
 * serve`. They are DTOs — deliberately decoupled from the in-process domain
 * models (`@excalibur/work-items` `NormalizedWorkItem`, `RunRecord`, …) so the
 * web contract can stay stable while internals evolve, and so this leaf package
 * carries no dependency on the stores. The serve layer maps domain → DTO; the
 * Svelte client imports these types for its typed API client.
 *
 * The whole dashboard is WORK-ITEM-CENTRIC: the home is the kanban board, and
 * everything (runs, patches, PRs, plans, discovery) hangs off a work item. The
 * routes below mirror that information architecture.
 */

/**
 * Canonical kanban lanes. MUST stay in sync with `WORK_ITEM_LANES` in
 * `@excalibur/work-items` (this leaf package can't import it without a cycle);
 * `apps/cli` imports both and a type-level assertion there guards the match.
 */
export const DASHBOARD_LANES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type DashboardLane = (typeof DASHBOARD_LANES)[number];

/** Human label per lane (board column headers). */
export const DASHBOARD_LANE_LABELS: Readonly<Record<DashboardLane, string>> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

/** A single item of the agent's live checklist (the `task_update` snapshot). */
export interface ChecklistItemDto {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A work item as it appears on a board card (compact). */
export interface WorkItemSummary {
  /** Stable key, e.g. `WI-12`. */
  key: string;
  title: string;
  /** Raw provider status (free string); `lane` is the canonical projection. */
  status: string | null;
  lane: DashboardLane;
  priority: string | null;
  labels: string[];
  assignee: string | null;
  /** Number of runs linked to this work item (the activity badge). */
  runCount: number;
  /** Kanban rank within the lane (lower = higher). */
  order: number;
  updatedAt: string | null;
  /**
   * The id of an in-flight run advancing this item (`running` /
   * `waiting_approval`), or null. When set, the card shows a live indicator.
   */
  activeRunId: string | null;
  /**
   * The active run's latest `update_tasks` checklist snapshot (D1). Empty when
   * there is no active run or it hasn't emitted a checklist yet. Lets the
   * in-progress card surface the agent's live plan without opening the run.
   */
  checklist: ChecklistItemDto[];
}

/** One board column: a lane plus its cards in board order. */
export interface DashboardBoardLane {
  lane: DashboardLane;
  label: string;
  items: WorkItemSummary[];
}

/** `GET /api/board` — the kanban home (D1). */
export interface BoardResponse {
  lanes: DashboardBoardLane[];
  /** ISO timestamp the board was assembled (for the "updated x ago" hint). */
  generatedAt: string;
}

/** A run as it appears in a work item's activity list / the runs explorer (D4). */
export interface RunSummary {
  id: string;
  title: string;
  status: string;
  workflow: string;
  model: string | null;
  startedAt: string;
  completedAt: string | null;
  /** Rolled-up cost/usage from the run's model-call ledger (null until known). */
  costCents: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The work item this run advanced, if any. */
  workItemId: string | null;
}

/** One lane (child run) of a parallel orchestration (AO4e). */
export interface OrchestrationLaneDto {
  runId: string;
  title: string;
  status: string;
  costCents: number | null;
  /** The work item this lane advanced, if any (AO4e-3) — surfaced per-lane so the
   * task-centric dashboard shows which work item each parallel lane is moving. */
  workItemId: string | null;
}

/**
 * A parallel orchestration (AO4e): a parent swarm run plus its per-lane child
 * runs, projected from the run store by `parentRunId`. Powers a live multi-lane
 * view of the parallel work the dashboard was previously blind to.
 */
export interface OrchestrationSummary {
  parentRunId: string;
  title: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  workItemId: string | null;
  laneCount: number;
  lanes: OrchestrationLaneDto[];
}

/** A lane's state in the orchestration chronogram (AO6 Pillar 2). */
export type ChronogramLaneState = 'pending' | 'running' | 'done' | 'empty' | 'failed' | 'cancelled';

/** One lane of the chronogram: a node in the wave/DAG timeline. */
export interface ChronogramLaneDto {
  id: string;
  title: string;
  instruction: string;
  /** 0-based wave index (which dependency level this lane ran in). */
  wave: number;
  /** Lane ids this lane depends on (the DAG edges). */
  dependsOn: string[];
  state: ChronogramLaneState;
  /** The child run this lane streams to (click-through target), if persisted. */
  runId: string | null;
  costCents: number | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Wall-clock span once finished (completedAt − startedAt); null while live. */
  durationMs: number | null;
}

/**
 * The orchestration CHRONOGRAM (AO6 Pillar 2): a swarm projected as a live
 * wave/DAG timeline — the structure (waves + dependsOn) from the persisted
 * `orchestration-plan.json` (written at swarm start) joined with the live
 * per-lane child-run state/cost/timing. Feeds both the dashboard timeline and
 * the TTY `renderChronogram`, so they stay byte-aligned like `reduceRail`.
 */
export interface ChronogramDto {
  parentRunId: string;
  task: string;
  mode: 'flat' | 'staged';
  /** Overall parent-run status. */
  status: string;
  startedAt: string;
  completedAt: string | null;
  workItemId: string | null;
  /** Lane-id groupings in execution order (one wave for `flat`). */
  waves: string[][];
  lanes: ChronogramLaneDto[];
  totalCostCents: number | null;
  /**
   * Whether the orchestration is PAUSED mid-flight (AO6 Pillar 3): a live swarm
   * stops dispatching new lanes and holds at the gate; in-flight lanes finish.
   * Derived from the persisted control flag, independent of the run status.
   */
  paused: boolean;
}

/** An external link off a work item (PR / commit / doc). */
export interface WorkItemLinkDto {
  type: 'pull_request' | 'commit' | 'document' | 'url' | 'issue' | 'other';
  url: string;
  title: string | null;
}

/** A comment / interaction on a work item. */
export interface WorkItemCommentDto {
  author: string | null;
  body: string;
  createdAt: string | null;
}

/** A plan associated with a work item (D3). */
export interface PlanRefDto {
  /** Plan file slug/id. */
  id: string;
  status: 'proposed' | 'approved' | 'executed' | 'cancelled';
  createdAt: string | null;
  planRun: string | null;
  execRun: string | null;
}

/** `GET /api/work-items/:key` — the work-item drill-down (D1/D2/D3). */
export interface WorkItemDetail {
  key: string;
  title: string;
  description: string | null;
  status: string | null;
  lane: DashboardLane;
  priority: string | null;
  labels: string[];
  assignee: string | null;
  reporter: string | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  parentKey: string | null;
  /** Runs that advanced this item (newest first). */
  runs: RunSummary[];
  links: WorkItemLinkDto[];
  comments: WorkItemCommentDto[];
  /** Plans linked to this item (D3 fills the link; D0 ships the shape). */
  plans: PlanRefDto[];
}

/** A saved plan as it appears in the Plans list (D3). */
export interface PlanSummary {
  /** Filename-without-`.md` id (e.g. `20260622-101500-ship-d3`). */
  id: string;
  task: string;
  status: 'proposed' | 'approved' | 'executed' | 'cancelled';
  created: string | null;
  planRun: string | null;
  execRun: string | null;
}

/** A plan with its markdown body (D3 drill-in). */
export interface PlanDetail extends PlanSummary {
  body: string;
}

/** One plan-shaping recommendation toggled into scope (D — dashboard panel). */
export interface PlanShapeRecommendationDto {
  title: string;
  detail: string;
  /** Pre-checked in the panel when true. */
  recommended: boolean;
}

/**
 * A plan-shaping proposal for the dashboard "shape & start" panel (D), mirroring
 * the core `PlanShape`. `surface` is the gate result (large / unclear / has
 * optional scope) so the web UI can stay quiet for a clear, small task.
 */
export interface PlanShapeView {
  complexity: 'small' | 'medium' | 'large';
  clear: boolean;
  questions: string[];
  recommendations: PlanShapeRecommendationDto[];
  surface: boolean;
}

/** One explored subsystem in a {@link ScopeMapView} (AO9-4) — mirrors the core
 * `ScopeFragment`. The dashboard never imports `@excalibur/core`, so the wire
 * shape is duplicated here as a plain DTO (JSON-identical to the core type). */
export interface ScopeFragmentView {
  subsystem: string;
  files: string[];
  whatExists: string;
  whatsMissing: string;
  risks: string[];
}

/** A read-only "Understand-first" scope of a task for the dashboard Scope view
 * (AO9-4), mirroring the core `ScopeMap`. Computed on demand (a model fan-out),
 * never persisted — `POST /api/scope` returns this or `null` when unconfigured. */
export interface ScopeMapView {
  task: string;
  summary: string;
  subsystems: ScopeFragmentView[];
  risks: string[];
  openQuestions: string[];
}

/** A discovery session summary (D3). */
export interface DiscoverySummary {
  id: string;
  title: string;
  status: 'open' | 'completed' | 'cancelled';
  recommendation: string | null;
  recommendedAutonomyLevel: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** A per-key cost/usage bucket (by model or by workflow) — mirrors core insights. */
export interface CountCostDto {
  key: string;
  runs: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

/** A per-day cost/run bucket for the time-series chart. */
export interface DayBucketDto {
  day: string;
  runs: number;
  costCents: number;
}

/**
 * Aggregate insights for the analytics view (D4). Structurally mirrors core's
 * `InsightsReport` (what `GET /api/insights` returns) so the client can type it
 * without importing the server package.
 */
export interface InsightsReportDto {
  totalRuns: number;
  byStatus: Record<string, number>;
  completionRate: number;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalModelCalls: number;
  totalFilesChanged: number;
  totalApprovals: number;
  totalVerificationsBlocked: number;
  avgCostCentsPerRun: number;
  byModel: CountCostDto[];
  byWorkflow: CountCostDto[];
  byDay: DayBucketDto[];
}

/**
 * The dashboard's route map — task-first. The client is a hash-routed SPA, so
 * these are the canonical in-app paths; the API paths they read are alongside.
 */
export const DASHBOARD_ROUTES = {
  /** Kanban home (D1/D2). */
  board: '/',
  /** Work-item drill-down (D1/D2/D3). `:key` = e.g. WI-12. */
  workItem: '/work-items/:key',
  /** Runs explorer + cost/token charts (D4). */
  runs: '/runs',
  /** A single run's live rail (D4/D5). */
  run: '/runs/:id',
  /** Insights / analytics (D4). */
  insights: '/insights',
  /** Plans & discovery (D3). */
  plans: '/plans',
} as const;

/** The JSON API surface the dashboard reads (kept beside the routes for clarity). */
export const DASHBOARD_API = {
  health: '/health',
  board: '/api/board',
  workItem: (key: string) => `/api/work-items/${encodeURIComponent(key)}`,
  runs: '/api/runs',
  run: (id: string) => `/api/runs/${encodeURIComponent(id)}`,
  runEvents: (id: string) => `/api/runs/${encodeURIComponent(id)}/events`,
  runStream: (id: string) => `/api/runs/${encodeURIComponent(id)}/stream`,
  insights: '/api/insights',
  plans: '/api/plans',
  plan: (id: string) => `/api/plans/${encodeURIComponent(id)}`,
  discovery: '/api/discovery',
} as const;
