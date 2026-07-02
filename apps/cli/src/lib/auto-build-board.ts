import { basename } from 'node:path';
import {
  MemoryStore,
  SprintStore,
  buildPlanMemoryEntry,
  renderPlanMarkdown,
  savePlan,
  setPlanStatus,
  updatePlanStep,
  writePlanSidecar,
  type PlanStepStatus,
  type Sprint,
  type StructuredPlan,
  type StructuredPlanStep,
} from '@excalibur/core';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import { changedFiles } from './memory-priming';
import { materializePlanIntoWorkItems, syncStepWorkItemLane } from './plan-work-items';

/**
 * F1-KEYSTONE — every auto-build becomes durable product state, with zero ceremony.
 *
 * `dispatchAutoBuild` (the default high-autonomy build path) used to render its
 * decomposition as an EPHEMERAL plan card and throw the structure away — so the
 * flagship product layer (plans → work items → sprints → burndown → dashboard)
 * never received a byte from ordinary builds: the durable pipeline only ran on the
 * posture-`ask` path, i.e. the highest-autonomy users got the least of it (the
 * activation audit's root finding). This module is the missing glue: persist the
 * decomposition as a structured plan, materialize it onto the kanban (multi-lane →
 * epic + sub-tasks with dependency edges; single lane → ONE plain card, an epic
 * wrapping one sub-task is board noise), attach the items to a rolling weekly
 * sprint so the burndown gets data for free, and live-sync step status while the
 * build runs. Everything here is best-effort by contract: a board write must NEVER
 * perturb (let alone abort) the build itself.
 */

/** The live links between one auto-build and its durable product state. */
export interface AutoBuildBoard {
  /** The persisted plan id (`.excalibur/plans/<id>.md` + `.plan.json`). */
  planId: string;
  plan: StructuredPlan;
  /** The epic work-item key (multi-lane builds only; single-lane has no epic). */
  epicWorkItemId: string | null;
  /** subtask id → its plan step (with `workItemId` stamped once materialized). */
  stepBySubtask: ReadonlyMap<string, StructuredPlanStep>;
  /** The rolling sprint the step items were attached to, or null. */
  sprintId: string | null;
}

/**
 * The subset of a decomposed subtask the board needs. Kept structural (rather than
 * importing the swarm's type) so the board glue stays dependency-light; a
 * `SwarmSubtask` satisfies it as-is.
 */
export interface BoardSubtask {
  id: string;
  title: string;
  instruction?: string;
  dependsOn?: ReadonlyArray<string>;
}

/** A lane instruction is a fine card description, but capped — it's a prompt. */
const ACCEPTANCE_MAX = 500;

/** `YYYY-MM-DD` in local time (sprint windows are date-granular). */
function ymd(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** ISO-8601 week label (`2026-W27`) — the rolling sprint's name. */
function isoWeekLabel(date: Date): string {
  // ISO week: Thursday of the current week determines the week-numbering year.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The Monday→Sunday window (local dates) containing `date`. */
function weekWindow(date: Date): { start: string; end: string } {
  const dow = date.getDay() === 0 ? 7 : date.getDay();
  const monday = new Date(date);
  monday.setDate(date.getDate() - (dow - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: ymd(monday), end: ymd(sunday) };
}

/**
 * The ACTIVE sprint covering today, or a fresh Monday→Sunday one created active.
 * One rolling bucket per week — auto-builds never create parallel sprints.
 */
function ensureRollingSprint(repoRoot: string, now: Date): Sprint {
  const store = new SprintStore(repoRoot);
  const today = ymd(now);
  const active = store
    .listSprints()
    .find((s) => s.status === 'active' && s.startDate <= today && today <= s.endDate);
  if (active !== undefined) {
    return active;
  }
  const window = weekWindow(now);
  return store.createSprint({
    name: `Sprint ${isoWeekLabel(now)}`,
    startDate: window.start,
    endDate: window.end,
    status: 'active',
  });
}

/**
 * Persists an auto-build decomposition as a durable plan, materializes it onto the
 * board, and attaches the items to the rolling sprint. Returns the live links the
 * caller uses to sync progress, or null when persistence failed (the build must
 * proceed regardless — the board is a bonus, never a gate).
 */
export function materializeAutoBuild(
  repoRoot: string,
  task: string,
  subtasks: ReadonlyArray<BoardSubtask>,
  options: { planRunId: string; now?: Date },
): AutoBuildBoard | null {
  try {
    if (subtasks.length === 0) {
      return null;
    }
    const now = options.now ?? new Date();

    // subtask id → step id, so lane dependencies become plan-step dependency edges
    // (unknown ids are dropped rather than producing dangling deps).
    const stepIdOf = new Map<string, string>();
    subtasks.forEach((s, i) => stepIdOf.set(s.id, `p1.s${i + 1}`));
    const steps: StructuredPlanStep[] = subtasks.map((s, i) => {
      const deps = (s.dependsOn ?? [])
        .map((d) => stepIdOf.get(d))
        .filter((d): d is string => d !== undefined);
      const acceptance = (s.instruction ?? '').replace(/\s+/g, ' ').trim().slice(0, ACCEPTANCE_MAX);
      return {
        id: `p1.s${i + 1}`,
        title: s.title,
        status: 'pending' as const,
        ...(deps.length > 0 ? { deps } : {}),
        ...(acceptance.length > 0 ? { acceptance } : {}),
      };
    });
    const plan: StructuredPlan = {
      version: 1,
      phases: [{ id: 'p1', title: 'Workstreams', steps }],
    };
    const file = savePlan(repoRoot, {
      task,
      planMarkdown: renderPlanMarkdown(plan),
      plan,
      status: 'approved',
      planRunId: options.planRunId,
      now,
    });
    const planId = basename(file).replace(/\.md$/, '');

    let epicWorkItemId: string | null = null;
    if (steps.length > 1) {
      epicWorkItemId = materializePlanIntoWorkItems(repoRoot, planId, plan, task).epicWorkItemId;
    } else {
      const step = steps[0];
      if (step !== undefined) {
        const item = new LocalWorkItemProvider(repoRoot).createWorkItem({
          title: step.title,
          ...(step.acceptance !== undefined ? { description: step.acceptance } : {}),
          labels: ['build'],
          status: 'todo',
        });
        step.workItemId = item.key;
        writePlanSidecar(repoRoot, planId, plan);
      }
    }

    // Attach the STEP items (not the epic — that would double-count the burndown)
    // to the rolling weekly sprint. Best-effort on top of best-effort.
    let sprintId: string | null = null;
    try {
      const sprint = ensureRollingSprint(repoRoot, now);
      const provider = new LocalWorkItemProvider(repoRoot);
      for (const step of steps) {
        if (step.workItemId !== undefined) {
          provider.updateWorkItem(step.workItemId, { cycleOrSprint: sprint.id });
        }
      }
      sprintId = sprint.id;
    } catch {
      /* the sprint attach failing must not lose the plan/board links */
    }

    const stepBySubtask = new Map<string, StructuredPlanStep>();
    subtasks.forEach((s, i) => {
      const step = steps[i];
      if (step !== undefined) {
        stepBySubtask.set(s.id, step);
      }
    });
    return { planId, plan, epicWorkItemId, stepBySubtask, sprintId };
  } catch {
    return null;
  }
}

/**
 * Live-syncs one subtask's plan step (on-disk checkpoint) AND its board card onto
 * `status` — the same PLAN2/PLAN3 twin-write the structured-plan driver does.
 */
export function markAutoBuildStep(
  repoRoot: string,
  board: AutoBuildBoard,
  subtaskId: string,
  status: PlanStepStatus,
  runId?: string,
): void {
  const step = board.stepBySubtask.get(subtaskId);
  if (step === undefined) {
    return;
  }
  step.status = status;
  if (runId !== undefined) {
    step.runId = runId;
  }
  try {
    updatePlanStep(repoRoot, board.planId, step.id, status, runId);
  } catch {
    /* the on-disk checkpoint is best-effort; the build continues regardless */
  }
  if (step.workItemId !== undefined) {
    syncStepWorkItemLane(repoRoot, step.workItemId, status);
  }
}

/**
 * Settles every step to its final status (per-subtask when known, `fallback`
 * otherwise) and promotes the plan to `executed` when everything landed. A plan
 * with blocked/pending steps stays `approved` — i.e. resumable.
 */
export function settleAutoBuild(
  repoRoot: string,
  board: AutoBuildBoard,
  task: string,
  outcome: {
    statusBySubtask?: ReadonlyMap<string, PlanStepStatus>;
    fallback: PlanStepStatus;
  },
): void {
  for (const subtaskId of board.stepBySubtask.keys()) {
    const status = outcome.statusBySubtask?.get(subtaskId) ?? outcome.fallback;
    markAutoBuildStep(repoRoot, board, subtaskId, status);
  }
  const allLanded = [...board.stepBySubtask.values()].every(
    (s) => s.status === 'done' || s.status === 'skipped',
  );
  if (allLanded) {
    try {
      setPlanStatus(repoRoot, board.planId, 'executed');
    } catch {
      /* best-effort */
    }
  }
  // F1 — PLAN6 extended to the auto path: every ordinary build leaves a decision
  // memory keyed to the files it touched (the capture side used to ride only the
  // posture-`ask` plan pipeline → zero memory nodes ever existed in practice).
  // The store reinforces-not-duplicates, so repeat builds stay clean.
  try {
    new MemoryStore(repoRoot).capture(
      buildPlanMemoryEntry(repoRoot, board.plan, {
        task,
        planRunId: board.planId,
        completed: allLanded,
        blockedStepIds: [...board.stepBySubtask.values()]
          .filter((s) => s.status === 'blocked')
          .map((s) => s.id),
        extraPaths: changedFiles(repoRoot),
      }),
    );
  } catch {
    /* memory promotion is best-effort */
  }
}
