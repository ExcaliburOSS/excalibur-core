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
  AuthoredChecklistItemDto,
  BackgroundThreadView,
  BoardResponse,
  ChecklistItemDto,
  ChronogramDto,
  ChronogramLaneDto,
  ChronogramLaneState,
  DashboardBoardLane,
  DashboardLane,
  CountCostDto,
  DayBucketDto,
  DiscoverySummary,
  ExcaliburEvent,
  InsightsReportDto,
  OrchestrationLaneDto,
  OrchestrationSummary,
  PlanDetail,
  PlanPhaseDto,
  PlanProgressDto,
  PlanRefDto,
  PlanShapeRecommendationDto,
  PlanShapeView,
  PlanStepDto,
  PlanStepStatusDto,
  PlanSummary,
  BurndownPointDto,
  SprintSummary,
  SprintDetail,
  ScopeFragmentView,
  ScopeMapView,
  ScheduleJobView,
  SessionSummary,
  SessionDetail,
  SessionTurnDto,
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

/**
 * Accent color per lane (board column headers / card stripes) — UI only.
 * Cooled toward the Cobalt palette (accent #4DA3FF, amber #F2C94C, teal #3DD6A8)
 * while keeping each column a distinct hue for scannability.
 */
export const LANE_COLORS: Readonly<Record<DashboardLane, string>> = {
  backlog: '#5a6678',
  todo: '#4da3ff',
  in_progress: '#f2c94c',
  review: '#9d8bff',
  done: '#3dd6a8',
};
