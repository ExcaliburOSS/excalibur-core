import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '@excalibur/shared';

/**
 * #10 — ORCHESTRATION telemetry. Distinct from the work-item board (which tracks
 * WHAT was built): this records HOW each auto-orchestration performed — how wide it
 * fanned out, how many waves, how many lanes landed vs failed, whether the merge
 * applied. Append-only JSONL at `.excalibur/telemetry/orchestrations.jsonl`, the
 * same local-files model as runs/plans/memory (no network, no external sink), so a
 * future `excalibur stats` (and the founder's proactivity KPI) can answer "how
 * often does auto-orchestration actually fan out and land?" from real data.
 *
 * Best-effort: every function swallows I/O faults — telemetry must NEVER perturb a
 * build. The recorder redacts the task text before writing.
 */

/** One orchestration's shape + outcome. Timestamps are supplied by the caller
 * (the CLI owns the clock) so this stays a pure data record. */
export interface OrchestrationRecord {
  /** ISO timestamp of the orchestration's completion. */
  at: string;
  /** The (redacted) task, capped — for a human-readable log line. */
  task: string;
  /** `swarm` = fanned out into ≥2 parallel lanes; `sequential` = one focused run. */
  shape: 'swarm' | 'sequential';
  /** Total lanes the orchestration ran. */
  lanes: number;
  /** Dependency waves (1 for a flat single-wave swarm; >1 = staged). */
  waves: number;
  /** Lanes that landed cleanly. */
  done: number;
  /** Lanes that failed / conflicted. */
  failed: number;
  /** Lanes that produced no change. */
  empty: number;
  /** Whether the merged diff actually applied to the tree (survived verify). */
  applied: boolean;
}

function telemetryFile(repoRoot: string): string {
  return join(repoRoot, '.excalibur', 'telemetry', 'orchestrations.jsonl');
}

/** Appends one orchestration record (best-effort; redacts the task; never throws). */
export function recordOrchestration(repoRoot: string, record: OrchestrationRecord): void {
  try {
    const file = telemetryFile(repoRoot);
    mkdirSync(dirname(file), { recursive: true });
    const safe: OrchestrationRecord = {
      ...record,
      task: redactSecrets(record.task).replace(/\s+/g, ' ').trim().slice(0, 200),
    };
    appendFileSync(file, `${JSON.stringify(safe)}\n`, 'utf8');
  } catch {
    /* telemetry is additive — a write fault must never break the build */
  }
}

/** Reads all orchestration records (best-effort; skips corrupt lines; newest last). */
export function readOrchestrationTelemetry(repoRoot: string): OrchestrationRecord[] {
  const file = telemetryFile(repoRoot);
  if (!existsSync(file)) {
    return [];
  }
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as OrchestrationRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is OrchestrationRecord => r !== null);
  } catch {
    return [];
  }
}

/** The aggregate KPIs over a set of orchestration records (pure). */
export interface OrchestrationSummary {
  /** How many orchestrations were recorded. */
  runs: number;
  /** Fraction (0..1) that fanned out into a parallel swarm (the proactivity KPI). */
  fanOutRate: number;
  /** Fraction (0..1) whose merged result actually landed on the tree. */
  applyRate: number;
  /** Mean lanes per orchestration. */
  avgLanes: number;
  /** Total lanes across all orchestrations, and how many landed. */
  totalLanes: number;
  totalDone: number;
}

/** Computes the KPI summary from records (pure; deterministic). */
export function summarizeOrchestrations(
  records: ReadonlyArray<OrchestrationRecord>,
): OrchestrationSummary {
  const runs = records.length;
  if (runs === 0) {
    return { runs: 0, fanOutRate: 0, applyRate: 0, avgLanes: 0, totalLanes: 0, totalDone: 0 };
  }
  const swarms = records.filter((r) => r.shape === 'swarm').length;
  const applied = records.filter((r) => r.applied).length;
  const totalLanes = records.reduce((n, r) => n + r.lanes, 0);
  const totalDone = records.reduce((n, r) => n + r.done, 0);
  return {
    runs,
    fanOutRate: swarms / runs,
    applyRate: applied / runs,
    avgLanes: totalLanes / runs,
    totalLanes,
    totalDone,
  };
}
