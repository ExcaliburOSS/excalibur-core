/**
 * Native kanban lanes for the first-party work-item store (WK1).
 *
 * The work item's `status` is a free string (so remote providers keep their own
 * vocabularies). For the native board we project any status onto one of five
 * canonical lanes via {@link laneOf}, and the local store writes these canonical
 * values when it creates/moves an item — but legacy/foreign statuses (`open`,
 * `closed`, `in-progress`, …) still land in a sensible lane.
 */
export const WORK_ITEM_LANES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type WorkItemLane = (typeof WORK_ITEM_LANES)[number];

/** Human label per lane (for the terminal board / dashboard headers). */
export const WORK_ITEM_LANE_LABELS: Readonly<Record<WorkItemLane, string>> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

/** Maps any status string onto a canonical lane (tolerant of legacy/remote values). */
export function laneOf(status: string | null | undefined): WorkItemLane {
  const s = (status ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  switch (s) {
    case 'backlog':
      return 'backlog';
    case 'todo':
    case 'to_do':
    case 'open':
    case 'new':
    case '':
      return 'todo';
    case 'in_progress':
    case 'doing':
    case 'started':
    case 'active':
      return 'in_progress';
    case 'review':
    case 'in_review':
    case 'reviewing':
      return 'review';
    case 'done':
    case 'closed':
    case 'completed':
    case 'resolved':
    case 'merged':
      return 'done';
    default:
      return 'todo';
  }
}

/** Whether a string is a canonical lane id. */
export function isWorkItemLane(value: string): value is WorkItemLane {
  return (WORK_ITEM_LANES as readonly string[]).includes(value);
}
