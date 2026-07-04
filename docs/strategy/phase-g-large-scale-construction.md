# Phase G — World-class construction of _any_ application, _any_ size

> **Thesis.** The launch plan (P0 solidity + P1 proactivity + universal
> materialization) makes Excalibur _launch-grade_: it survives, it feels good, and
> every request leaves durable product state. It does **not**, by itself, make the
> claim _"Excalibur can build any application, no matter how large, with clear
> plans, phases, subphases, agent orchestration and information exploration —
> world-class"_ **true**. Phase G is the workstream that makes that claim
> demonstrable. It is also the real moat: CC and OpenCode are excellent
> _single-agent loops_; neither composes a **durable multi-phase plan with a swarm
> per phase** that drives itself to completion across restarts.

Date opened: 2026-07-03. Owner: founder + Excalibur. Status: **planned** (open
_after_ v1.12.0 ships).

---

## 0. What already works (verified in code — do not rebuild)

Phase G builds on real strengths. Auditors cited these with file:line:

| Capability                                                                                                            | Where                                                                                                            | State                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Two-tier in-turn compaction (truncate tool output → cheap-model summarize middle)                                     | `packages/core/src/compaction/in-turn-compactor.ts`                                                              | **Strong.** Long single turns don't overflow context.                           |
| Durable, resumable **structured plans** (checkpoint per step, resume-on-startup offer, auto-advance N→N+1, dep-gated) | `packages/core/src/plans/plan-runner.ts`, `apps/cli/src/session/agent-turn.ts:1177`, `repl.ts` `offerResumePlan` | **Strong** — but each step is a _solo_ turn (see G1).                           |
| Staged **dependency waves** + per-wave verification gate + bounded self-heal                                          | `packages/core/src/swarm/run-swarm.ts:625` (`verifyWave`), `:353` (heal)                                         | **Good.** Gates default **ON when a test command exists** (`swarm.ts:348,351`). |
| Compounding **memory** (reinforce on corroboration, supersede on contradiction, path-ranked recall, phase-start seed) | `packages/core/src/memory/memory-store.ts`, `agent-turn.ts:782` (`memorySeed`)                                   | **Good** foundation; retrieval ceiling at scale (G4).                           |
| Universal **materialization** (every mutating turn → plan + work items + sprint)                                      | `apps/cli/src/lib/auto-build-board.ts`, `repl.ts` `settleTurnMaterialization`                                    | **Done** (this session).                                                        |

**The two execution engines that exist today:**

1. **Swarm path** — `dispatchAutoBuild` (`repl.ts:2501`) → `decomposeTask` (≤6
   subtasks, `swarm.ts:152`) → `chooseBuildShape` → `runSwarmFlow`
   (`swarm.ts:971`) → staged topological waves (`toposort.ts`) + verify + merge.
   **Parallel, but one flat burst.** Caps: `SWARM_MAX_TOTAL_AGENTS = 8`
   (`concurrency.ts:23`), nesting `depth ≤ 1` (`run-swarm.ts:454`).
2. **Structured-plan path** — `runStructuredPlan` (`plan-runner.ts:66`), each step
   executed as "a focused [single-agent] turn" (`agent-turn.ts:1122`).
   **Multi-phase + durably resumable, but no fan-out per step.**

> **The headline gap: these two engines are not composed.** A plan runs its steps
> one solo agent at a time; a swarm is one flat decomposition with no multi-phase
> plan above it and no cross-session drive. Neither _alone_ builds a large app.

---

## 1. The six gaps (grounded, prioritized by leverage)

### G1 — Compose the plan engine × the swarm engine _(highest leverage)_

- **Problem.** `runStructuredPlan`'s step executor is a solo turn; `runSwarmFlow`
  is a flat burst. A large app needs: **the plan drives phases; each phase fans
  its independent steps into a swarm; an integration gate runs between phases; the
  whole plan self-drives and resumes.**
- **Evidence.** `agent-turn.ts:1122` ("each step is a focused turn");
  `runSwarmFlow` is invoked from `repl.ts` / `orchestrate.ts` / `swarm.ts` /
  `mission-run.ts` — **never** from inside the plan step executor.
- **Design.** Make the plan step executor _shape-aware_: a step (or a phase's set
  of independent steps) whose sub-work is ≥2 independent workstreams dispatches
  through the **same** `runSwarmFlow` used by `dispatchAutoBuild`, with the phase
  boundary as the wave-verify gate. Reuse — do not fork — `chooseBuildShape`,
  `topologicalWaves`, `verifyWave`, self-heal, worktrees.
- **Choke point (where it's guaranteed, not per-lane).** In the single plan-step
  executor in `agent-turn.ts`; every plan — authored, resumed, or materialized
  from `dispatchAutoBuild` — flows through it.
- **Proof.** Real-model harness: a 3-phase plan where phase 2 has 3 independent
  steps → assert 3 parallel lanes ran in phase 2, the phase-2 gate ran before
  phase 3, and a killed process resumes mid-phase-2.

### G2 — Recursive decomposition (epic → phase → subphase → task)

- **Problem.** Decomposition is **2 levels** (plan = phase→step; swarm =
  task→subtask ≤6). A 200-task app is flattened.
- **Evidence.** `swarm.ts:152` `maxSubtasks ?? 6`; plan model is `phases[].steps[]`.
- **Design.** A **depth-budgeted recursive planner**: a step estimated as "too
  big" (heuristic: >N files, >M subsystems, or the planner's own confidence)
  expands into a **sub-plan** (its own phases/steps) up to a depth budget
  (default 3: epic→phase→task, with subphase as the 4th when warranted). The plan
  model already nests conceptually; add a `subPlanId` edge on a step and let
  `runStructuredPlan` recurse into it. Keep an _atomic escape_ (a step the planner
  marks indivisible never expands).
- **Choke point.** The planner (`decompose`/plan authoring), gated by a single
  `maxPlanDepth` config with a hard cap.
- **Proof.** Give it "build a multi-tenant SaaS with billing, auth, admin, and a
  public API" → assert a ≥3-level plan tree materializes into nested work items
  with correct `blockedBy` edges, and it renders in the dashboard tree.
- **STATUS (done this pass).** Implemented as `decomposeDeep` (`swarm.ts`): the
  task decomposes, each STILL-BIG subtask re-decomposes (and so on), and the tree
  is FLATTENED to leaf subtasks whose deps encode the hierarchy (namespaced ids
  `t2_t1` resolve parent→leaves by prefix). The EXISTING staged executor runs them
  as dependency WAVES, so hierarchy depth = wave depth — deep AND wide (with G6, no
  caps), no worktree nesting, no model/plan-model change. Termination is by
  atomicity + STRICT length decrease (every child shorter than its parent), so
  there is NO fixed depth cap yet it always ends. Wired into the auto-build path
  (`dispatchAutoBuild` now calls `decomposeDeep`). Verified deterministically: a
  big subsystem re-decomposes into ordered leaves; an atomic task is untouched; a
  no-progress split terminates (no explosion). cli 682 / core 596 green.

### G3 — Autonomous multi-phase drive + mission resume

- **Problem.** `dispatchAutoBuild` is one burst; **missions checkpoint but have no
  public resume**; only solo-step plans self-drive to completion.
- **Evidence.** `mission-store.ts:20` (`saveMission`), `supervisor.ts:120`
  (`resumeFrom` exists) — but `runMissionTurn` always mints a new id
  (`mission-run.ts:414`) and never loads a prior mission. No `/resume-mission`.
- **Design.** (a) A first-class **"drive to done"** loop for the composed
  plan×swarm engine: keep executing ready waves until the plan is complete or
  genuinely blocked, honoring the abort/interrupt contract, budget-aware. (b)
  Wire mission resume: `findResumableMission` + a startup offer symmetric to
  `offerResumePlan`, feeding `supervisor.resumeFrom`. (c) Cross-session: a large
  build survives a restart and continues unattended.
- **Choke point.** The drive loop lives at the dispatch layer (one loop, all
  entry paths); resume offer at REPL startup next to `offerResumePlan`.
- **Proof.** Start a long build, `SIGKILL` mid-phase, relaunch → it offers to
  resume and finishes the remaining phases without re-prompting.
- **STATUS (done this pass).** Two halves:
  - **Auto-build resume was ALREADY enabled** by G1: `materializeAutoBuild` saves
    the plan `status: 'approved'`, so an interrupted build leaves an approved plan
    with pending steps that `offerResumePlan` finds at launch → `driveStructuredPlan`
    re-runs ONLY the pending steps, fanning independent ones into a swarm (G1). A
    large build survives a restart and continues, unattended.
  - **Mission resume** (the genuine gap) is now wired: `findResumableMission`
    (`mission-store.ts`) returns the newest NOT-done mission (paused OR crashed);
    `offerResumeMission` (repl, symmetric to `offerResumePlan`) offers it at launch;
    `runMissionTurn({resume})` skips re-interpretation and feeds the saved
    `MissionState` to `runMission`'s `resumeFrom`, picking up at the first
    unfinished capability step. The "drive to done" loop itself already exists
    (`runSwarmFlow` staged waves for builds; `runMission` for missions). Verified
    deterministically (findResumableMission: newest not-done wins, crash-resume not
    just paused). core 598 / cli 682 green.

### G4 — Raise the retrieval ceiling for very large repos

- **Problem.** Pure lexical search + path-ranked memory, **no semantic index**.
  Degrades on 500k-LOC repos when picking the right few files.
- **Evidence.** `packages/context-engine/src/search/code-search.ts` ("NO
  embeddings, NO persisted index, NO network").
- **Design.** A **local, deterministic symbol/def index** (ctags-class or a
  tree-sitter symbol table) that `investigate` and the scope explorers query
  first, falling back to lexical. Keep it dependency-light and offline (brand
  constraint: no telemetry, no network retrieval). Optional later: a local
  embedding index behind a flag. This _raises the ceiling of what "any size"
  means_ — do it after G1–G3 unlock composition.
- **Choke point.** `computeScope` / `investigate` retrieval, transparently.
- **Proof.** On a large fixture repo, assert investigate surfaces the correct
  target files that pure lexical search misses.

### G5 — Deterministic self-review backstop _(pairs with G1)_

- **Problem.** Even with the imperative prompt (shipped in v1.12.0), the model
  **did not call `review`/`verify`** on a non-trivial change in a real-Kimi run.
  Prompt wording ≠ guarantee. Unreviewed steps compound errors across a large
  build.
- **Evidence.** This session's real-Kimi run: tools fired were
  `write_file/run_command/update_tasks` — no `review`/`verify`.
- **Design.** A **deterministic post-edit gate** at the choke point: after a step
  produces a non-trivial diff, run `review` (self-check, no nested model call for
  the cheap path) / `verify` automatically and fold findings back into a bounded
  fix loop — the same "guarantee at the choke point, not the model's discretion"
  principle that fixed materialization. Config-gated, on by default for
  non-trivial diffs.
- **Choke point.** The plan-step / swarm-lane completion path (one place).
- **Proof.** Real-model harness: a step that introduces a deliberate bug is
  caught and fixed by the automatic review gate without the user asking.

### G6 — Lift the fan-out ceilings: budget+machine governors, not fixed caps

- **Problem.** Three limits throttle scale today, all conservative DEFAULTS
  (nobody asked for them; they are the original runaway-DoS rails):
  1. `SWARM_MAX_TOTAL_AGENTS = 8` (`concurrency.ts:23`) — the AUTO path's total
     lanes-per-run ceiling. Overridable via `--max-agents`, but the auto path
     (the one a large build actually uses) is stuck at 8.
  2. concurrency-at-once = `cpus-1` (+ budget) (`concurrency.ts:46`) — a REAL
     resource governor; keep it, but it should scale with the machine, not cap
     total work.
  3. nesting `depth ≤ 1` (`run-swarm.ts:454`) — a swarm may spawn ONE nested
     level, never a grandchild. The hard rail (naive recursion is exponential).
- **Design — governors, not removal (uncapping outright is the footgun the rails
  prevent).**
  - **Total lanes per run:** replace the fixed `8` with a budget+machine-aware
    ceiling (`orchestration.maxAgents` config override; default scales with
    `budget.remaining()` — the cost cap is waived, so this rises to "as many as
    the work needs", executed in WAVES). A large app gets MANY lanes total.
  - **Concurrency-at-once:** keep CPU-bound (`cpus-1`) so N total lanes run in
    waves of ~cores at a time — this is what keeps a 200-lane build from melting
    the laptop. Add the budget term. Log what was capped (no silent truncation).
  - **Nesting depth:** turn `≤1` into a CONFIGURABLE depth BUDGET (`maxSwarmDepth`,
    default 2–3), coupled with G2's recursive plan so hierarchy is bounded-but-
    deeper, NOT unbounded recursion. Depth × width stays governed end-to-end.
- **Choke point.** `capTotalAgents` / `chooseConcurrency` (`concurrency.ts`) and
  the depth gate (`run-swarm.ts:454`), fed by one `orchestration` config block.
- **Proof.** Unit tests: total-lane ceiling scales with budget; concurrency stays
  CPU-bound; a depth-2 plan fans out two levels while depth-3 is refused at the
  configured budget. Real-model: a large seeded plan runs >8 lanes total in waves.
- **Priority.** NOT minor — this is a direct blocker to "any app, any size".
  Pairs with G2 (recursive plan) and G3 (drive-to-done).
- **STATUS (done this pass).** The FIXED build ceilings are removed: the auto path
  no longer slices the decomposition to 8 (`swarm.ts` — `lanes = subtasks`, no
  drop), `decomposeTask` splits to the work's natural granularity (default
  6 → 12), and the `depth ≤ 1` hard block is gone (`run-swarm.ts` — nests to any
  depth, termination by atomicity). `chooseConcurrency` (CPU-bound wave governor)
  stays — it schedules N lanes in waves, it does NOT drop them. `planAgentAllocation`
  is display-only (never limited execution). `SWARM_MAX_TOTAL_AGENTS` is retired
  from the auto path. Remaining refinements: add the budget term to wave sizing;
  lazy per-wave worktree creation only matters at extreme (100s of lanes) scale,
  which the recursive plan (G2) keeps per-level width modest anyway.
- **NOTE — separate subsystem.** Read-only EXPLORATION breadth
  (`EXPLORE_MAX_FILES`, scope angles) is a distinct grounding knob, not a build
  agent/depth cap; left bounded (it is for fast context-gathering, not building).

---

## 2. Sequencing

```
v1.12.0 (SHIPPED) ── launch-grade: solidity + proactivity + materialization
        │
        ├─ G1  compose plan × swarm            ┐  the unlock — makes "any size" real
        ├─ G5  deterministic review backstop   ┘  (ship together; G5 rides G1's choke point)
        │
        ├─ G2  recursive decomposition         ┐  makes "any size" *representable*
        ├─ G3  autonomous drive + resume       ┘  makes it *finish, unattended, across restarts*
        │
        └─ G4  semantic/symbol index           (raises the ceiling of "any size")
             G6  budget-aware sizing           (polish, fold into G3)
```

**Milestone G-α (G1 + G5).** A structured plan where a phase fans into a
verified swarm, with an automatic review gate per step. This is the single demo
that proves the thesis — pick it as the flagship post-launch artifact.

**Milestone G-β (G2 + G3).** Recursive plans that drive themselves to completion
across a restart. This is what lets a user say "build me X" for a genuinely large
X and walk away.

**Milestone G-γ (G4 + G6).** Scale + economics polish.

---

## 3. Verification doctrine (non-negotiable — the founder's standing rule)

A capability is **not done** until a **real-model** harness proves it _fires on
the default path_ — unit tests that call the function directly do not count
(that is exactly how the materialization and self-review gaps hid). Every G ships
with a `scripts/verify-g*.mjs` real-Kimi harness driven over a pty, asserting the
_observable_ behavior (lanes ran, gate ran, resume happened, review caught the
bug), not just that the code path exists.

Corollary: **guarantee at the choke point, never in one lane.** Each G above
names its single choke point for this reason.

---

## 4. Definition of done for the Phase-G claim

Excalibur can be handed _"build \<any non-trivial application\>"_ and will:

1. produce a **multi-level plan** (epic→phase→subphase→task) materialized into a
   dependency-linked board (G2);
2. **drive it to completion**, fanning each phase's independent work into a
   **verified swarm**, self-reviewing each step (G1 + G5);
3. **survive restarts** and continue unattended (G3);
4. stay grounded on a **large codebase** via symbol-aware retrieval (G4);
5. size its parallelism to the **budget/machine** (G6) —

…and every step of that is **provable by a real-model harness**, not asserted.
That is the "build any app, any size, world-class" claim, made true.
