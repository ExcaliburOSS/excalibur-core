import type { TaskType } from '../onboarding/onboarding';
import { RunManager } from '../runs/run-manager';

/**
 * Pre-flight estimate (plan differentiator #2) — a data-driven dry-run forecast
 * shown BEFORE a run: estimated cost + ETA, blast radius, and how many past runs
 * informed it. It refines from the repo's OWN history (the most recent completed
 * runs of the same workflow, from the cost ledger + start/complete timestamps)
 * and falls back to a per-task-type heuristic on a cold start. Pure-ish (reads
 * the local run store); deterministic given the store + inputs.
 *
 * Pairs with the hard budget cap: the CLI warns when the estimate would exceed
 * `--budget` before a single token is spent.
 */

export interface RunEstimate {
  /** Forecast model spend, in cents. */
  estCostCents: number;
  /** Forecast wall-clock, in ms. */
  estDurationMs: number;
  /** Distinct files/modules the task is likely to touch. */
  blastRadius: number;
  /** Historical runs that informed it (0 → pure heuristic / cold start). */
  basedOnRuns: number;
}

/** Cold-start priors per task type: rough cents + ms-per-affected-unit. */
const HEURISTIC: Partial<Record<TaskType, { cents: number; msPerUnit: number }>> = {
  docs: { cents: 1, msPerUnit: 12_000 },
  bugfix: { cents: 2, msPerUnit: 25_000 },
  security: { cents: 3, msPerUnit: 30_000 },
  refactor: { cents: 4, msPerUnit: 35_000 },
  feature: { cents: 5, msPerUnit: 45_000 },
  migration: { cents: 8, msPerUnit: 60_000 },
  alternatives: { cents: 6, msPerUnit: 50_000 },
  ambiguous: { cents: 3, msPerUnit: 30_000 },
};
const DEFAULT_PRIOR = { cents: 4, msPerUnit: 35_000 };

export interface EstimateInput {
  workflow: string;
  taskType: TaskType;
  /** Affected units (blast radius), e.g. from `estimateAffectedUnits(task)`. */
  affectedUnits: number;
  /** How many recent same-workflow runs to average (default 10). */
  sampleSize?: number;
}

/** Forecasts cost + ETA for a run, refining from history when available. */
export function estimateRun(repoRoot: string, input: EstimateInput): RunEstimate {
  const manager = new RunManager(repoRoot);
  const blastRadius = Math.max(1, input.affectedUnits);

  // History: the most recently COMPLETED runs of the same workflow. listRuns() is
  // ordered by START time (run id), so sort by completedAt to honour "most recent
  // completed" — a run started early but finishing late must still count as recent.
  const completed = manager
    .listRuns()
    .filter(
      (r) =>
        r.record.workflow === input.workflow &&
        r.record.status === 'completed' &&
        r.record.completedAt !== null,
    )
    .sort((a, b) => Date.parse(b.record.completedAt as string) - Date.parse(a.record.completedAt as string));
  const recent = completed.slice(0, input.sampleSize ?? 10);

  if (recent.length > 0) {
    let cost = 0;
    let duration = 0;
    let durationSamples = 0;
    for (const run of recent) {
      cost += manager.readModelCalls(run.id).reduce((sum, call) => sum + (call.costCents ?? 0), 0);
      const ms = Date.parse(run.record.completedAt as string) - Date.parse(run.record.startedAt);
      if (Number.isFinite(ms) && ms > 0) {
        duration += ms;
        durationSamples += 1;
      }
    }
    const prior = HEURISTIC[input.taskType] ?? DEFAULT_PRIOR;
    return {
      estCostCents: cost / recent.length,
      estDurationMs: durationSamples > 0 ? duration / durationSamples : prior.msPerUnit * blastRadius,
      blastRadius,
      basedOnRuns: recent.length,
    };
  }

  // Cold start: per-task-type prior, scaled by blast radius.
  const prior = HEURISTIC[input.taskType] ?? DEFAULT_PRIOR;
  return {
    estCostCents: prior.cents,
    estDurationMs: prior.msPerUnit * blastRadius,
    blastRadius,
    basedOnRuns: 0,
  };
}
