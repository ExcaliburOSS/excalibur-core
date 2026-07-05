# Enterprise Cost Workstream (E1–E6)

> **Goal.** Make cost **accurate, attributed, auditable and enforceable** at
> Enterprise scale — so an org can answer "who spent what, on which work, under
> which rates, within which budget?" from real data. Builds ON the existing
> per-call ledger + budget + insights; does NOT duplicate them.

Opened 2026-07-05. Foundation already shipped (v1.14.0): a layered pricing model
(`config rate > .excalibur/pricing.json > bundled table (asOf) > unknown`), so
per-call cost is real and price drift is a data-file edit, not a release. See
`docs/strategy/` + `[[project-excalibur-cost-pricing]]`.

## What already exists (build on it — file:line)

- **Per-call ledger** `model-calls.jsonl`: `ModelCallLine {provider, model, inputTokens,
outputTokens, costCents, timestamp}` (`run-manager.ts:38`), appended per call in
  `execute-local-run.ts:449`.
- **Budget** `BudgetLedger {spent, cap, exceeded()}` (`budget-ledger.ts:9`); hard
  deny-by-dollars in `execute-local-run.ts:418` (`BudgetExceededError`); cap from
  `config.budget.maxRunUsd`. Mission-level budget pause in `supervisor.ts`.
- **Aggregation** `collectInsights`/`aggregateInsights` → `excalibur insights`
  (`insights.ts:70`, `commands/insights.ts`): totals + byModel/byWorkflow/byDay.
- **Attribution today**: `RunRecord.workItemId` + `parentRunId` (`artifacts.ts:47`).
  NO userId / sprintId / planId on runs. `memory-node.author` exists (OSS git user;
  Enterprise userId) but not on runs.
- **enterprise-sync**: `pushRun/pushEvent/pullConfig`; `EnterpriseConfig` has
  `allowedModels/policies/…` but NO cost/pricing/chargeback fields.

## The gaps → the workstream

### E1 — Accurate, attributed, audited cost records _(the foundation)_

- **E1a `unknown` ≠ `$0`.** Aggregation sums `costCents ?? 0`, so an UNKNOWN-priced
  call reads as free — hiding real spend (the whole point of the pricing fix). Track
  cost as `{ knownCents, unknownCalls }` end-to-end; surface "$X + N calls unpriced".
- **E1b Actor attribution.** Capture the ACTOR on each run (OSS: git user email;
  Enterprise: the authenticated userId) at run creation → `RunRecord.actor`. Enables
  per-user chargeback — the biggest Enterprise gap.
- **E1c Pricing-source audit.** Record `pricingSource: 'config'|'table'|'unknown'`
  on each `ModelCallLine` (thread the `PricingSource` we already compute through
  `ChatOutput` → the recorder), so every cent is auditable to its rate origin.
- **E1d Sprint/plan edges.** Capture `sprintId`/`planId` on the run when in scope,
  so cost rolls up to a sprint/epic (the burndown's money side).

### E2 — Chargeback rollup + `excalibur cost`

- Extend `aggregateInsights` with **byActor / bySprint / byWorkItem** breakdowns and
  the known/unknown split. New `excalibur cost` (or `insights --by actor|sprint`) that
  answers chargeback questions. Read-only, from the local ledger.

### E3 — Org pricing policy (versioned, distributed)

- Add a `pricing` block to `EnterpriseConfig` (rates + `asOf` + version) pulled via
  `pullConfig`, written to the local `.excalibur/pricing.json` override the gateway
  already reads. Negotiated org rates, distributed by policy, no per-dev setup.

### E4 — Budget enforcement beyond the single run

- Per-**actor** and per-**org** budgets (day/month), not just per-run. A rolling
  spend ledger checked at model-call time (reuse `BudgetLedger` semantics); deny /
  warn thresholds. Enterprise budgets flow via `EnterpriseConfig`.

### E5 — Cost sync to the control plane

- A **cost summary / chargeback payload** shape for `enterprise-sync` (per run:
  cost, tokens, actor, workItem/sprint, pricing source) so the org control plane
  aggregates centrally — instead of pushing raw runs and re-deriving.

### E6 — Alerting + anomaly (later)

- Threshold alerts (a run/actor/day over $X), simple anomaly flags. Post-E1–E5.

## Sequencing & doctrine

E1 first — everything else reads the records it produces. E1a (unknown≠$0) + E1b
(actor) are the highest-leverage, most self-contained; ship them first. Then E2
(the view), E3 (org rates), E4 (org budgets), E5 (sync). **Config rate stays the
billing source of truth throughout; the code is never a pricing oracle.** Every
piece deterministic + tested; a bad pricing/config file is never fatal.
