/**
 * Swarm runaway controller + concurrency governor (AO3a).
 *
 * Two PURE, deterministic, fail-closed safety functions sitting in front of the
 * swarm executor. They never do I/O (the caller reads `os.cpus()`, the budget,
 * etc. and passes them in) so the policy is unit-testable and explainable.
 *
 *  - {@link capTotalAgents} bounds how many lanes a run may EVER fan out to,
 *    regardless of what the model's decomposition asked for — a runaway
 *    decomposition can never DoS the machine or the API bill.
 *  - {@link chooseConcurrency} bounds how many lanes run AT ONCE, from the
 *    machine's CPU headroom and (when known) the remaining budget — so the
 *    bounded pool is sized sanely instead of firing every lane simultaneously
 *    (the prior behaviour: `runSwarmFlow` never set `maxConcurrency`, so the
 *    pool defaulted to ALL lanes at once).
 */

/**
 * Hard fail-closed ceiling on the TOTAL number of lanes a single swarm run may
 * fan out to when the caller gives no explicit `--max-agents`. A deliberate
 * power-user ceiling can go higher; the auto path never exceeds this.
 */
export const SWARM_MAX_TOTAL_AGENTS = 8;

/** Inputs to {@link chooseConcurrency} (all already resolved by the caller). */
export interface ConcurrencyInput {
  /** How many lanes this wave wants to run. */
  laneCount: number;
  /** `os.cpus().length` at the call site. */
  cpuCount: number;
  /** Remaining run budget in cents; `undefined` = no budget constraint. */
  remainingBudgetCents?: number;
  /** Rough cost of one lane in cents; `undefined`/≤0 = unknown (skip the budget cap). */
  perLaneCostEstimateCents?: number;
  /** Explicit concurrency ceiling (e.g. derived from `--max-agents`); `undefined` = none. */
  hardCap?: number;
}

/**
 * Chooses how many lanes run concurrently (≥1). Lanes are model-I/O-bound, so
 * the binding constraints are CPU headroom (leave one core for the main
 * process) and, when known, how many lanes the remaining budget can fund. The
 * result never exceeds `laneCount`, the CPU headroom, the affordable count, or
 * an explicit `hardCap`.
 */
export function chooseConcurrency(input: ConcurrencyInput): number {
  const lanes = Math.max(1, Math.floor(input.laneCount));
  // Leave one core for the main process; always allow at least one worker.
  const cpuHeadroom = Math.max(1, Math.floor(Math.max(1, input.cpuCount)) - 1);
  let limit = Math.min(lanes, cpuHeadroom);

  // Never run more lanes at once than the remaining budget can fund.
  if (
    input.remainingBudgetCents !== undefined &&
    Number.isFinite(input.remainingBudgetCents) &&
    input.perLaneCostEstimateCents !== undefined &&
    Number.isFinite(input.perLaneCostEstimateCents) &&
    input.perLaneCostEstimateCents > 0
  ) {
    const affordable = Math.floor(input.remainingBudgetCents / input.perLaneCostEstimateCents);
    limit = Math.min(limit, Math.max(1, affordable));
  }

  if (input.hardCap !== undefined && Number.isFinite(input.hardCap)) {
    limit = Math.min(limit, Math.max(1, Math.floor(input.hardCap)));
  }

  return Math.max(1, limit);
}

/**
 * Fail-closed backstop on the TOTAL lanes per run. Returns `min(requested,
 * hardCap)`, never below 1. The auto path passes {@link SWARM_MAX_TOTAL_AGENTS};
 * a power-user `--max-agents N` passes its own (possibly higher) ceiling.
 */
export function capTotalAgents(
  requested: number,
  hardCap: number = SWARM_MAX_TOTAL_AGENTS,
): number {
  const r = Math.max(1, Math.floor(requested));
  const cap = Math.max(1, Math.floor(hardCap));
  return Math.min(r, cap);
}
