import {
  materializePlanWorkItems,
  writePlanSidecar,
  type PlanMaterializeResult,
  type PlanStepStatus,
  type StructuredPlan,
} from '@excalibur/core';
import { LocalWorkItemProvider } from '@excalibur/work-items';

/**
 * PLAN2 glue: materialize a structured plan into LOCAL work-items (epic + per-step
 * sub-tasks + dependency edges) and persist the resulting `workItemId`/`epicWorkItemId`
 * links back into the plan sidecar. Idempotent — a re-approval / resume never
 * duplicates (the materializer skips already-linked steps). Best-effort: the caller
 * treats a failure as non-fatal (a work-items write must never abort an execution).
 */
export function materializePlanIntoWorkItems(
  repoRoot: string,
  planId: string,
  plan: StructuredPlan,
  task: string,
): PlanMaterializeResult {
  const provider = new LocalWorkItemProvider(repoRoot);
  const result = materializePlanWorkItems(
    plan,
    {
      createWorkItem: (input) =>
        provider.createWorkItem({
          title: input.title,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.labels !== undefined ? { labels: input.labels } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.parentExternalId !== undefined
            ? { parentExternalId: input.parentExternalId }
            : {}),
          ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
        }),
      setBlockedBy: (key, blockedBy) => {
        provider.updateWorkItem(key, { blockedBy });
      },
    },
    { task },
  );
  // Persist the new links into the sidecar (the source of truth) so they survive.
  if (result.created > 0) {
    writePlanSidecar(repoRoot, planId, plan);
  }
  return result;
}

/** The kanban lane a plan step's linked work-item should sit in for a given status. */
function laneForStepStatus(status: PlanStepStatus): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'active':
      return 'in_progress';
    case 'blocked':
      return 'review';
    default:
      return 'todo';
  }
}

/**
 * Live-syncs a plan step's linked work-item onto the lane matching its status, so
 * the kanban board tracks step-by-step execution (PLAN3) in real time. Best-effort
 * and silent — a board write never perturbs the run.
 */
export function syncStepWorkItemLane(
  repoRoot: string,
  workItemId: string,
  status: PlanStepStatus,
): void {
  try {
    new LocalWorkItemProvider(repoRoot).updateWorkItem(workItemId, {
      status: laneForStepStatus(status),
    });
  } catch {
    /* the board sync is best-effort; execution continues regardless */
  }
}
