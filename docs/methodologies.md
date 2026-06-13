# Methodologies

A **methodology** is a template for how to work: philosophy, recommended autonomy, when to use it (and when not to), expected artifacts, roles and approval behavior. Methodologies are **never imposed** — they are presets you opt into. A methodology typically maps onto a default workflow.

```bash
excalibur methodologies list
excalibur methodologies explain spec-driven
```

Like workflows, the catalog comes from the extension host: 14 built-ins, overridable by YAML files in `.excalibur/methodologies/`.

## Built-in catalog (14)

| ID | Levels | Flow |
|---|---|---|
| `lightweight` | 0–1 | Question → AI response → developer decides |
| `review-first` | 0–2 | Developer writes code → AI reviews → developer fixes → PR |
| `patch-proposal` | 2 | Task → AI patch → human reviews → human applies |
| `fast-fix` | 2–3 | Task → branch → AI patch → tests → summary |
| `plan-then-execute` | 3–4 | Task → short plan → implementation → tests → review |
| `spec-driven` | 3–4 | Task → spec → plan → tasks → implementation → verification |
| `tdd-agentic` | 2–4 | Failing test first → implementation → tests pass → review |
| `safe-refactor` | 2–4 | Scope → invariants → baseline tests → refactor → diff review |
| `security-first` | 0–4 | Risk analysis → plan → implementation → security review → approval |
| `migration` | 3–4 | Migration plan → compat check → implementation → rollback notes |
| `explore-then-choose` | 3–4 | Alternatives → trade-offs → choose → implement |
| `human-gated` | 3–4 | Plan → human approval → implementation → human approval → PR |
| `discovery` | 0–1 | Clarify before building; can recommend **not** building |
| `agentic-agile-light` | 0–1 | Lightweight async rituals: daily summaries, weekly plans |

## Choosing guidance

- **spec-driven** — ambiguous, customer-facing, multi-module work that needs traceability.
- **tdd-agentic** — bugs, regression prevention, critical business logic.
- **safe-refactor** — when no behavior change is intended.
- **security-first** — auth, payments, contracts, PII, permissions, secrets.
- **explore-then-choose** — complex decisions; presented as *approach exploration* (`Approach A — Minimal Change / Approach B — Clean Architecture / Approach C — Performance-Oriented`), never as model comparison.
- **discovery** — when the idea/ticket itself is unclear; see [getting-started.md](getting-started.md#5-discovery-decide-before-you-build).

## Anatomy of a methodology

```yaml
id: spec-driven
name: Spec-Driven Development
description: >
  A structured workflow for turning ambiguous tasks into specs, plans, tasks
  and verified implementation.
recommendedAutonomyLevels: [3, 4]
useWhen:
  - Requirements are ambiguous
  - Multiple modules are involved
avoidWhen:
  - Tiny bugfixes
  - Urgent hotfixes
defaultWorkflow: structured-feature
phases: [understand, specify, plan, implement, verify, review]
artifacts: [spec.md, plan.md, tasks.md, verification.md]
agentRoles: [planner, implementer, reviewer, tester]
approval:
  spec: optional
  plan: optional
  beforePr: recommended
riskProfile: medium
```

## Custom methodologies

```bash
excalibur extensions create methodology spike-driven
excalibur extensions validate
excalibur methodologies list   # shows spike-driven with source "local"
```

Or drop a YAML file into `.excalibur/methodologies/`. See [extensions/creating-a-methodology.md](extensions/creating-a-methodology.md).
