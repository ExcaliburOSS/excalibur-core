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
} as const;
