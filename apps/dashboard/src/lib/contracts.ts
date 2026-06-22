/**
 * Re-exports the dashboard wire contracts (the single source of truth lives in
 * `@excalibur/shared`) as TYPE-ONLY imports — so nothing from that package's
 * runtime (zod, `node:crypto`, …) is pulled into the browser bundle. The lane
 * ORDER + COLORS are small UI constants declared locally; the lane order is
 * pinned to the shared `DashboardLane` union via `satisfies`, so a renamed/typo'd
 * lane fails to compile here, and the SERVER mapper carries the authoritative
 * add/remove/reorder parity guard against `@excalibur/work-items`. Labels are
 * not duplicated — they are translated via i18n.
 */
export type {
  BoardResponse,
  ChecklistItemDto,
  DashboardBoardLane,
  DashboardLane,
  DiscoverySummary,
  PlanDetail,
  PlanRefDto,
  PlanSummary,
  RunRecord,
  RunSummary,
  WorkItemCommentDto,
  WorkItemDetail,
  WorkItemLinkDto,
  WorkItemSummary,
} from '@excalibur/shared';

import type { DashboardLane } from '@excalibur/shared';

/** Lane order for board columns. `satisfies` pins each id to the shared union. */
export const LANES = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
] as const satisfies readonly DashboardLane[];

/** Accent color per lane (board column headers / card stripes) — UI only. */
export const LANE_COLORS: Readonly<Record<DashboardLane, string>> = {
  backlog: '#5b6577',
  todo: '#5b9dff',
  in_progress: '#e2b341',
  review: '#c08bff',
  done: '#4ec9a8',
};
