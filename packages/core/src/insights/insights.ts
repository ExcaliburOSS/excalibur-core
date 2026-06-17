import type { ExcaliburEvent, RunStatus } from '@excalibur/shared';
import { RunManager, type ModelCallLine } from '../runs/run-manager';

/**
 * `excalibur insights` (plan P2.5) — the cross-run lens. Folds EVERY local run's
 * record + cost/token ledger + event stream into one aggregate report: spend,
 * tokens, completion/acceptance rate, per-model and per-workflow breakdowns, and
 * a per-day trend. This beats Claude Code's session-only `/usage` (it spans the
 * whole `.excalibur/runs/` history) and is the OSS seed of the Enterprise
 * 5-lens Insights dashboard (M5) — both fold the SAME `aggregateInsights`.
 *
 * Pure core (the aggregator is disk-free + deterministic → unit-testable); the
 * CLI is a thin renderer.
 */

/** Per-run facts extracted from the run's record + ledger + event stream. */
export interface RunInsight {
  id: string;
  status: RunStatus;
  model: string | null;
  workflow: string;
  /** ISO-8601 start; the day bucket is its `YYYY-MM-DD` prefix. */
  startedAt: string;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  /** Distinct files the run changed (from `patch_generated` events). */
  filesChanged: number;
  /** Inline approvals seen (approved + rejected). */
  approvals: number;
  /** Verification-mesh verdicts that BLOCKED the run. */
  verificationsBlocked: number;
}

export interface CountCost {
  key: string;
  runs: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DayBucket {
  day: string;
  runs: number;
  costCents: number;
}

export interface InsightsReport {
  totalRuns: number;
  /** Runs per terminal status (completed/failed/cancelled/running). */
  byStatus: Record<string, number>;
  /** completed / (completed + failed + cancelled); 0 when none terminal. */
  completionRate: number;
  totalCostCents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalModelCalls: number;
  totalFilesChanged: number;
  totalApprovals: number;
  totalVerificationsBlocked: number;
  avgCostCentsPerRun: number;
  byModel: CountCost[];
  byWorkflow: CountCost[];
  byDay: DayBucket[];
}

/** Folds per-run facts into the aggregate report. Pure + deterministic. */
export function aggregateInsights(runs: ReadonlyArray<RunInsight>): InsightsReport {
  const byStatus: Record<string, number> = {};
  const modelMap = new Map<string, CountCost>();
  const workflowMap = new Map<string, CountCost>();
  const dayMap = new Map<string, DayBucket>();

  let totalCostCents = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalModelCalls = 0;
  let totalFilesChanged = 0;
  let totalApprovals = 0;
  let totalVerificationsBlocked = 0;

  const bump = (
    map: Map<string, CountCost>,
    key: string,
    run: RunInsight,
  ): void => {
    const entry = map.get(key) ?? {
      key,
      runs: 0,
      costCents: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    entry.runs += 1;
    entry.costCents += run.costCents;
    entry.inputTokens += run.inputTokens;
    entry.outputTokens += run.outputTokens;
    map.set(key, entry);
  };

  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    totalCostCents += run.costCents;
    totalInputTokens += run.inputTokens;
    totalOutputTokens += run.outputTokens;
    totalModelCalls += run.modelCalls;
    totalFilesChanged += run.filesChanged;
    totalApprovals += run.approvals;
    totalVerificationsBlocked += run.verificationsBlocked;

    bump(modelMap, run.model ?? 'unknown', run);
    bump(workflowMap, run.workflow, run);

    const day = run.startedAt.slice(0, 10);
    const bucket = dayMap.get(day) ?? { day, runs: 0, costCents: 0 };
    bucket.runs += 1;
    bucket.costCents += run.costCents;
    dayMap.set(day, bucket);
  }

  const terminal =
    (byStatus['completed'] ?? 0) + (byStatus['failed'] ?? 0) + (byStatus['cancelled'] ?? 0);
  const completionRate = terminal > 0 ? (byStatus['completed'] ?? 0) / terminal : 0;

  // Stable ordering: spend-descending for breakdowns, chronological for the trend.
  const byCost = (a: CountCost, b: CountCost): number =>
    b.costCents - a.costCents || b.runs - a.runs || a.key.localeCompare(b.key);

  return {
    totalRuns: runs.length,
    byStatus,
    completionRate,
    totalCostCents,
    totalInputTokens,
    totalOutputTokens,
    totalModelCalls,
    totalFilesChanged,
    totalApprovals,
    totalVerificationsBlocked,
    avgCostCentsPerRun: runs.length > 0 ? totalCostCents / runs.length : 0,
    byModel: [...modelMap.values()].sort(byCost),
    byWorkflow: [...workflowMap.values()].sort(byCost),
    byDay: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** Extracts per-run facts from the cost ledger + event stream. */
function runInsightFrom(
  id: string,
  status: RunStatus,
  model: string | null,
  workflow: string,
  startedAt: string,
  calls: ReadonlyArray<ModelCallLine>,
  events: ReadonlyArray<ExcaliburEvent>,
): RunInsight {
  let costCents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const call of calls) {
    costCents += call.costCents ?? 0;
    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;
  }

  const changedFiles = new Set<string>();
  let approvals = 0;
  let verificationsBlocked = 0;
  for (const event of events) {
    if (event.type === 'approval_approved' || event.type === 'approval_rejected') {
      approvals += 1;
    } else if (event.type === 'verification' && event.payload['blocked'] === true) {
      verificationsBlocked += 1;
    } else if (event.type === 'patch_generated') {
      const affected = event.payload['filesAffected'];
      if (Array.isArray(affected)) {
        for (const f of affected) {
          if (typeof f === 'string' && f.length > 0) changedFiles.add(f);
        }
      }
    }
  }

  return {
    id,
    status,
    model,
    workflow,
    startedAt,
    costCents,
    inputTokens,
    outputTokens,
    modelCalls: calls.length,
    filesChanged: changedFiles.size,
    approvals,
    verificationsBlocked,
  };
}

export interface CollectInsightsOptions {
  /** Only include runs started on/after this ISO date (e.g. a `--since` cutoff). */
  sinceIso?: string;
}

/** Reads every local run and folds it into an {@link InsightsReport}. */
export function collectInsights(
  repoRoot: string,
  options: CollectInsightsOptions = {},
): InsightsReport {
  const manager = new RunManager(repoRoot);
  const runs: RunInsight[] = [];
  for (const run of manager.listRuns()) {
    if (options.sinceIso !== undefined && run.record.startedAt < options.sinceIso) {
      continue;
    }
    const calls = manager.readModelCalls(run.id);
    const events = manager.readEvents(run.id);
    runs.push(
      runInsightFrom(
        run.id,
        run.record.status,
        run.record.model,
        run.record.workflow,
        run.record.startedAt,
        calls,
        events,
      ),
    );
  }
  return aggregateInsights(runs);
}
