# Intent Simplification — 14 paths → 6 intents + 1 automatic execution layer

> **Doctrine.** The user never picks machinery. The classifier detects only **WHAT** the
> user wants (~6 intents); **HOW** it gets done — swarm, best‑of‑N, iterate‑to‑done, sizing,
> background, schedule, show‑the‑result, web — is **100% automatic and proactive**, applied by
> a single execution layer according to what the work actually needs. Zero user‑invoked
> commands, zero flags. Aligns with the founder's standing rule (see
> `[[feedback-auto-no-caps]]`): "todo automático, el usuario nunca invoca comandos".

Opened 2026-07-05. Planned as a **focused, phased routing refactor AFTER the TUI‑stability
release** (memory‑contamination + crash/dup/flicker + mission rail are shipping first). This is
routing — a bug here misbehaves on _every_ input — so it is deliberately phased and test‑gated.

## The problem with 14 paths

Today `intent-router.ts` classifies into 14 intents:
`chat · edit · plan · swarm · bg · research · goal · explore · preview · orchestration ·
schedule · mission · history · discovery`.

That taxonomy **conflates three different axes** as if they were one:

1. **What the user wants** (the real intent): inform · build/change · show · judge‑an‑idea ·
   undo · manage‑a‑run.
2. **How to execute** (should be AUTOMATIC, never a path): `swarm` (parallel), `explore`
   (best‑of‑N), `goal` (iterate‑until‑done), `plan`‑vs‑`mission` (size/shape).
3. **Cross‑cutting capabilities** (also automatic, not flags): `bg` (background),
   `schedule` (recurrence).

Consequences: real misroutes (e.g. a plain build classified as a `mission`), and a taxonomy that
contradicts the "everything automatic" doctrine by exposing execution strategies as if the user
should steer them.

## Target: 6 intents + one automatic execution layer

### Layer 1 — Intent (all the classifier decides)

| Intent            | Absorbs                                            | Meaning                                                                                                                 |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **chat**          | + `research`                                       | Wants an answer; nothing in the repo changes. Uses the web **by itself** when the question needs current/external info. |
| **build**         | + `edit`,`plan`,`swarm`,`mission`,`goal`,`explore` | Wants to create/change code — **auto‑scaled** (see Layer 2).                                                            |
| **preview**       | —                                                  | Wants to SEE/run the existing app.                                                                                      |
| **discovery**     | —                                                  | Floats an idea, wants judgment (build/validate/don't) — not to build yet.                                               |
| **history**       | —                                                  | Undo/rewind/revert the agent's OWN prior work.                                                                          |
| **orchestration** | —                                                  | View/pause/resume an EXISTING run/swarm.                                                                                |

Leaner option (defer): `preview`→`build` (a build that changes nothing, just serves) and
`discovery`→`chat` ⇒ **4 intents**. Recommendation: keep **6** — they are genuinely distinct verbs.

### Layer 2 — Automatic execution (all the "how", applied proactively)

Every intent passes through ONE execution layer that applies, **without any command or flag**,
whatever the situation needs. This is where the retired paths/flags now live as automatic
decisions:

- **Size/shape** — `decomposeDeep` decomposes and counts independent workstreams + kinds of work:
  1 unit → a single agentic turn; ≥2 independent units → **swarm** (parallel waves); several
  _different kinds_ of work (design + implement across modules + verify + ship) → the **mission
  DAG** (understand→plan→build→verify→ship). A **continuum** chosen by the decomposition, not three
  named paths — this is what kills the mission‑vs‑plan misroute.
- **explore (best‑of‑N)** — automatically when the approach is genuinely ambiguous / high‑stakes.
- **iterate‑to‑done** — verify + self‑heal until it is _actually_ green (`goal` made universal:
  every build iterates to done).
- **background** — NOT a flag. Default is foreground (which no longer blocks input, thanks to the
  persistent rail + INT‑1 typing‑during‑execution). A task **auto‑detaches** only on a real signal:
  the task is long AND the user pivots to independent work (the INT‑1 triage already routes
  "independent" work to background), or the user says so in natural language. Never a surprise.
- **schedule** — NOT a flag. The **cadence** ("cada mañana", "every 2h") is the one thing only the
  user has, but it is **understood from the language** (`parseScheduleSpec` already strips the
  scheduling words), and the recurrence is set up automatically inside normal `build`/`chat`
  handling. Proactive future step: detect a repeated manual task (3 mornings running) and OFFER to
  schedule it — pattern detected, not a command.
- **show the result** — a build that changed something ends by serving it + opening the browser
  (already shipped: `showResult` / `previewProject`).
- **web** — chat reaches for the web on its own when the answer needs current/external info.

The only irreducibly user‑provided datum is a schedule's **cadence** — and even that is parsed from
language, never selected. Everything else Excalibur decides according to need.

## Two‑layer routing

- **Classifier** (`buildDecisionPrompt` / `TURN_INTENTS` in `intent-router.ts`): ~6 categories →
  far fewer misroutes; a simpler prompt.
- **Execution planner** (inside the unified `build` dispatch): auto‑selects the machinery. This
  logic **already exists** — `decomposeDeep`, `chooseBuildShape`, `dispatchAutoBuild`, the
  self‑heal loop, the INT‑1 interrupt triage, `parseScheduleSpec`. The refactor **moves the
  decision earlier and removes the paths that exposed it**; it does not invent new machinery.

## Phased migration (low‑risk; routing is delicate)

- **Phase 0 — do not touch the engines.** decomposeDeep / swarm / mission / self‑heal intact.
- **Phase 1 — classifier to ~6.** Rewrite `buildDecisionPrompt`/`buildIntentPrompt` + `TURN_INTENTS`.
  Keep the old 14 as an INTERNAL mapping table (compat) so nothing breaks at once.
- **Phase 2 — unified build dispatch.** In `repl.ts`, route `build` (+ the old
  edit/plan/swarm/mission/goal/explore) through ONE `dispatchBuild` that calls the auto‑scaler;
  delete the separate branches.
- **Phase 3 — background + schedule as automatic execution.** Background = INT‑1 signal + long‑task
  heuristic (default foreground). Schedule = `parseScheduleSpec` detection applied within build/chat.
  Neither remains a top‑level intent or a flag.
- **Phase 4 — folds.** `research`→`chat` (auto‑web); optionally `preview`→`build`, `discovery`→`chat`.
- **Phase 5 — tests.** Update `intent-router.test.ts` for the new taxonomy; add tests that the
  auto‑scaler picks the right shape (single/swarm/mission) for representative tasks. **Real‑Kimi
  verification**: assert requests route to `build` and auto‑scale correctly — never that the user
  sees a path name.

## The one real risk + mitigation

Concentrating swarm/mission selection in the auto‑scaler means it must get **sizing** right.
Mitigation: the size is decided by the **decomposition's own structure** (atomicity‑terminated
recursion → N units → swarm; multiple capability kinds → mission DAG) — deterministic, testable,
and already built. And with no user‑facing path name, a slightly‑wrong size only means more/less
parallelism, **not a wrong deliverable** — far more forgiving than today's mission‑vs‑plan misroute.
