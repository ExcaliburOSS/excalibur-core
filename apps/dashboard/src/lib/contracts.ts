/**
 * Re-exports the dashboard wire contracts (the single source of truth lives in
 * `@excalibur/shared`) as TYPE-ONLY imports — so nothing from that package's
 * runtime (zod, etc.) is pulled into the browser bundle — plus the few small UI
 * constants the views need at runtime, declared locally to keep the bundle lean.
 */
export type {
  BoardResponse,
  DashboardBoardLane,
  DashboardLane,
  DiscoverySummary,
  PlanRefDto,
  RunSummary,
  WorkItemCommentDto,
  WorkItemDetail,
  WorkItemLinkDto,
  WorkItemSummary,
} from '@excalibur/shared';

import type { DashboardLane } from '@excalibur/shared';

/** Lane order for board columns (mirror of WORK_ITEM_LANES). */
export const LANES: readonly DashboardLane[] = ['backlog', 'todo', 'in_progress', 'review', 'done'];

/** Human label per lane. */
export const LANE_LABELS: Readonly<Record<DashboardLane, string>> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

/** Accent color per lane (board column headers / card stripes). */
export const LANE_COLORS: Readonly<Record<DashboardLane, string>> = {
  backlog: '#5b6577',
  todo: '#5b9dff',
  in_progress: '#e2b341',
  review: '#c08bff',
  done: '#4ec9a8',
};
