/**
 * A shared running-cost ledger with a hard cap (AO4c). Pure accounting: callers
 * `add()` each unit of spend and check `exceeded()` to decide whether to keep
 * going. Used to make the hard budget cap BIND across swarm parallelism — the
 * per-run cap in `ExecuteLocalRun` only governs a single sequential loop, so
 * without this a fanned-out swarm would silently blow past `--budget` /
 * `budget.maxRunUsd`. A null cap means "no limit" (never exceeded).
 */
export class BudgetLedger {
  private spentCents = 0;

  constructor(private readonly capCents: number | null) {}

  /** Accumulate spend (ignores null/NaN/≤0 so a missing cost is a no-op). */
  add(cents: number | null | undefined): void {
    if (typeof cents === 'number' && Number.isFinite(cents) && cents > 0) {
      this.spentCents += cents;
    }
  }

  get spent(): number {
    return this.spentCents;
  }

  get cap(): number | null {
    return this.capCents;
  }

  /** True once spend has reached the cap (a finite cap only). */
  exceeded(): boolean {
    return this.capCents !== null && this.spentCents >= this.capCents;
  }

  /** Cents left before the cap (Infinity when uncapped). */
  remainingCents(): number {
    return this.capCents === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.capCents - this.spentCents);
  }
}

/** Resolve a hard cap in CENTS from `budget.maxRunUsd` (dollars), or null. */
export function budgetCapCentsFromUsd(maxRunUsd: number | null | undefined): number | null {
  return typeof maxRunUsd === 'number' && maxRunUsd > 0 ? Math.round(maxRunUsd * 100) : null;
}
