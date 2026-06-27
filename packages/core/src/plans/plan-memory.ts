/**
 * PLAN6 — RICH plan memory. When a plan finishes (or stops), this builds a
 * recall-friendly {@link CaptureMemoryInput} from the structured plan: a digest of
 * the OUTCOME (phases→steps with status, the epic work-item, blocked steps) as the
 * rationale, and the FILES the plan touched as `subjectPaths` — the relevance key
 * the memory store ranks on. The old plan capture wrote a 600-char slice of raw
 * markdown with NO subjectPaths, so it scored 0 at recall and never surfaced; this
 * makes an executed plan prime future work that touches the same files.
 *
 * Files-touched is reconstructed from each step's run events (no re-run, no git):
 * `buildTurnSummary(loadReplay(repoRoot, runId)).changedFiles`.
 */

import type { CaptureMemoryInput } from '../memory/memory-node';
import { loadReplay } from '../replay/replay';
import { buildTurnSummary } from '../runs/turn-summary';
import { findStep, planProgress, type PlanStepStatus, type StructuredPlan } from './plan-model';

const STATUS_GLYPH: Record<PlanStepStatus, string> = {
  done: '✓',
  active: '▸',
  blocked: '✗',
  skipped: '⊘',
  pending: '○',
};

const MAX_PATHS = 24;
const MAX_RATIONALE = 600;

export interface PlanMemoryInput {
  /** The task the plan addressed (the recall handle in the statement). */
  task: string;
  /** The plan run id (recorded as the memory's source). */
  planRunId: string;
  /** Whether every step finished (a stronger memory than a partial one). */
  completed: boolean;
  /** Step ids that blocked, when not completed (surfaced as lessons). */
  blockedStepIds?: string[];
  /** Extra run ids whose files to fold in (e.g. a single-pass plan's one run). */
  extraRunIds?: string[];
}

/**
 * The repo-relative files a plan's executed steps touched — the union of each step
 * run's `changedFiles` (plus any `extraRunIds`), deduped and capped. Cheap: reads
 * `events.jsonl` per run, never re-executes anything. A missing/corrupt run is skipped.
 */
export function planFilesTouched(
  repoRoot: string,
  plan: StructuredPlan,
  extraRunIds: string[] = [],
): string[] {
  const files = new Set<string>();
  const runIds = [
    ...plan.phases
      .flatMap((p) => p.steps.map((s) => s.runId))
      .filter((id): id is string => id !== undefined),
    ...extraRunIds,
  ];
  for (const runId of runIds) {
    try {
      for (const f of buildTurnSummary(loadReplay(repoRoot, runId)).changedFiles) {
        if (f.path.length > 0) files.add(f.path);
      }
    } catch {
      /* a missing/corrupt run is skipped — files-touched is best-effort */
    }
  }
  return [...files].slice(0, MAX_PATHS);
}

/**
 * Builds the rich plan memory entry (a `decision` node) — see the module header.
 */
export function buildPlanMemoryEntry(
  repoRoot: string,
  plan: StructuredPlan,
  input: PlanMemoryInput,
): CaptureMemoryInput {
  const { total, done } = planProgress(plan);
  const subjectPaths = planFilesTouched(repoRoot, plan, input.extraRunIds ?? []);
  const blockedTitles = (input.blockedStepIds ?? [])
    .map((id) => findStep(plan, id)?.step.title)
    .filter((t): t is string => t !== undefined && t.length > 0);

  const statement = input.completed
    ? `Executed a plan for "${input.task}": ${done}/${total} step(s) across ${plan.phases.length} phase(s).`
    : `Plan for "${input.task}" stopped at ${done}/${total} step(s)${blockedTitles.length > 0 ? `, blocked on "${blockedTitles[0]}"` : ''}.`;

  // A compact phase→step outline + epic + files + blocked digest (budgeted).
  const outline = plan.phases
    .map(
      (p) => `${p.title}: ${p.steps.map((s) => `${STATUS_GLYPH[s.status]}${s.title}`).join(', ')}`,
    )
    .join(' | ');
  const parts: string[] = [`Approach — ${outline}`];
  if (plan.epicWorkItemId !== undefined) {
    parts.push(`Tracked as ${plan.epicWorkItemId}`);
  }
  if (subjectPaths.length > 0) {
    const shown = subjectPaths.slice(0, 6).join(', ');
    const more = subjectPaths.length > 6 ? ` (+${subjectPaths.length - 6} more)` : '';
    parts.push(`Touched ${shown}${more}`);
  }
  if (blockedTitles.length > 0) {
    parts.push(`Blocked: ${blockedTitles.join('; ')}`);
  }
  const rationale = parts.join('. ').slice(0, MAX_RATIONALE);

  return {
    type: 'decision',
    statement,
    rationale,
    ...(subjectPaths.length > 0 ? { subjectPaths } : {}),
    sourceRunId: input.planRunId,
    // A fully-completed plan is a stronger memory than a partial/blocked one.
    confidence: input.completed ? 0.8 : 0.6,
  };
}
