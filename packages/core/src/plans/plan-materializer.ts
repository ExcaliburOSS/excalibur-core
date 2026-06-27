/**
 * PLAN2 — materializes a {@link StructuredPlan} into WORK-ITEMS: the plan becomes an
 * EPIC, each step a sub-task under it (`parentExternalId` = epic key), and each
 * step's `deps` (step ids) become its sub-task's `blockedBy` dependency edges
 * (work-item keys). This is the bridge that makes planning and the kanban board the
 * SAME thing — an approved plan shows up as a tracked epic with sub-tasks.
 *
 * Pure orchestration: the caller injects the work-item create/update `ops`, so core
 * stays free of the work-items package. Idempotent — already-linked steps are
 * skipped and a present epic is reused, so a resume / re-entry never duplicates.
 * Mutates the plan in place (`step.workItemId` + `plan.epicWorkItemId`); the caller
 * persists the sidecar (e.g. `writePlanSidecar`) afterward.
 */

import type { StructuredPlan } from './plan-model';

/** The work-item creation a materializer needs (mirrors the local provider's input). */
export interface MaterializeWorkItemInput {
  title: string;
  description?: string;
  labels?: string[];
  /** Canonical lane id (e.g. `todo`); the provider maps it onto a lane. */
  status?: string;
  /** Parent work-item key (the epic), for a sub-task. */
  parentExternalId?: string;
  /** Work-item keys this item is blocked by (dependency edges). */
  blockedBy?: string[];
}

/** The injected work-item operations (so core does not depend on @excalibur/work-items). */
export interface PlanMaterializeOps {
  /** Create a work-item, returning its allocated key. */
  createWorkItem(input: MaterializeWorkItemInput): { key: string };
  /** Set the dependency edges on an already-created work-item. */
  setBlockedBy(key: string, blockedBy: string[]): void;
}

export interface MaterializePlanOptions {
  /** The plan task — the epic title. */
  task: string;
  /** Labels for the epic (default `['plan', 'epic']`). */
  epicLabels?: string[];
  /** Labels for each step sub-task (default `['plan-step']`). */
  stepLabels?: string[];
  /** The lane id new items land in (default `todo`). */
  status?: string;
}

export interface PlanMaterializeResult {
  /** The epic work-item key (the plan), or null when there were no steps. */
  epicWorkItemId: string | null;
  /** stepId → its work-item key (all steps, including pre-existing links). */
  stepWorkItemIds: Record<string, string>;
  /** How many work-items this call created (0 when already fully materialized). */
  created: number;
}

/**
 * Materializes the plan into an epic + per-step sub-tasks with dependency edges.
 * Idempotent and partial-safe: reuses an existing `epicWorkItemId`, skips any step
 * that already has a `workItemId`, and re-applies `blockedBy` (a set, not append).
 */
export function materializePlanWorkItems(
  plan: StructuredPlan,
  ops: PlanMaterializeOps,
  options: MaterializePlanOptions,
): PlanMaterializeResult {
  const steps = plan.phases.flatMap((p) => p.steps);
  const stepWorkItemIds: Record<string, string> = {};
  for (const s of steps) {
    if (s.workItemId !== undefined) stepWorkItemIds[s.id] = s.workItemId;
  }

  // Already fully materialized → no-op (a resume / re-approval never duplicates).
  if (steps.length > 0 && steps.every((s) => s.workItemId !== undefined)) {
    return { epicWorkItemId: plan.epicWorkItemId ?? null, stepWorkItemIds, created: 0 };
  }
  if (steps.length === 0) {
    return { epicWorkItemId: plan.epicWorkItemId ?? null, stepWorkItemIds: {}, created: 0 };
  }

  const status = options.status ?? 'todo';
  let created = 0;

  // 1. The EPIC (the plan) — reuse if a prior partial run already created it.
  let epicKey = plan.epicWorkItemId;
  if (epicKey === undefined) {
    epicKey = ops.createWorkItem({
      title: options.task,
      labels: options.epicLabels ?? ['plan', 'epic'],
      status,
    }).key;
    plan.epicWorkItemId = epicKey;
    created += 1;
  }

  // 2. Each step → a sub-task under the epic (create only the unlinked ones).
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      if (step.workItemId !== undefined) {
        continue;
      }
      const key = ops.createWorkItem({
        title: step.title,
        ...(step.acceptance !== undefined && step.acceptance.length > 0
          ? { description: step.acceptance }
          : {}),
        labels: options.stepLabels ?? ['plan-step'],
        status,
        parentExternalId: epicKey,
      }).key;
      step.workItemId = key;
      stepWorkItemIds[step.id] = key;
      created += 1;
    }
  }

  // 3. Resolve step deps (step ids) → sub-task blockedBy edges (now all keys exist).
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      if (step.workItemId === undefined) {
        continue;
      }
      const blockedBy = (step.deps ?? [])
        .map((depId) => stepWorkItemIds[depId])
        .filter((k): k is string => k !== undefined);
      if (blockedBy.length > 0) {
        ops.setBlockedBy(step.workItemId, blockedBy);
      }
    }
  }

  return { epicWorkItemId: epicKey, stepWorkItemIds, created };
}
