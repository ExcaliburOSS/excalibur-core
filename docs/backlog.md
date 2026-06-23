# Excalibur — Prioritized backlog (post-1.2.0)

> **CORE PRINCIPLE — work-item-centric dev cycle.** Excalibur's entire development
> cycle revolves around **task planning = work-items**. Runs AND agents are **linked
> to a work-item** (the unit of planning); patches, PRs, discovery and reports hang
> off it. Both the OSS local dashboard and the Enterprise manager web are articulated
> around tasks/work-items, NOT run trackers. This is foundational to what Excalibur
> is — see the `dashboard-task-centric` decision and Epic A (D0 first).

> Consolidated from three sources: the **OpenCode feature comparison** (June 2026),
> the **M1–M8 master roadmap** (`docs/ROADMAP.md`), and other pending tasks /
> honest in-code gaps. Keep this in sync with `docs/ROADMAP.md` and the live task
> list. Legend: **[Core]/[Ent]** repo · **[auto]** buildable now without
> credentials · **[cred]** needs keys/a decision · source: **OC**=OpenCode gap,
> **Mx**=milestone phase, **docs**=documentation debt.

## Recently shipped (already done — roadmap was stale)

F1–F8 external access (web_fetch/search/extract/crawl, opt-in local browser, hosted
readers, native cited research, anti-injection + provenance) · MCP OAuth/DCR +
Ed25519-signed registry · background/fleet (`/bg` + `/threads`) · onboarding
overhaul · **npm publish 1.2.0** (`@excalibur-oss/excalibur`, `latest`) ·
**OSS task-first dashboard D0–D5** (`excalibur serve`: kanban board + live
checklist + drag/start/cancel/approve + plans/discovery + insights charts + SSE +
read-only `--share`) · **publishable extension SDK** (`@excalibur-oss/extension-sdk`).

---

## AO — Auto-orchestration (FIRM directive, top priority) — task #186

> **Directive (user, 2026-06-23, emphatic):** the user will NEVER type
> `swarm`/`bg`/`threads`/`goal`/`research`. Those are **execution shapes
> Excalibur chooses and dimensions itself** from the plan + task — the slash
> commands survive only as a power-user escape hatch, never the default path.
> This is the [[feedback-proactive-intelligent]] core directive applied to
> parallelism.

- **Already automatic:** intent detection (`intent-router.ts` `classifyTurnIntent`
  → chat|plan|swarm|bg|research|goal, multilingual, no keywords) and swarm
  self-sizing (`decomposeTask` + `planAgentAllocation`, `apps/cli/src/lib/swarm.ts`;
  `--max-agents` is only an optional ceiling).
- **AO1 — auto-execute under autonomy** [Core][auto]: in `apps/cli/src/session/repl.ts`
  the heavy routes (swarm/bg/goal/research) are still `confirm()`-OFFERED — only
  `plan` auto-runs under `runtime.approvals.auto`. Make them auto-execute under
  auto / high autonomy with a non-blocking "auto-routed to swarm (N agents)"
  notice; keep the confirm only at low/non-auto levels.
- **AO2 — planner→parallelizer fusion** [Core][auto]: the planner and the
  parallelizer are decoupled today. Build an execution planner so an approved
  plan's dependency graph DERIVES the shape — independent steps → auto-sized
  swarm, dependent chain → sequential, long task → background thread — all linked
  to the work-item. Verify vs real Kimi; plan-first (sizeable arch change).

---

## DW — Web & docs refresh (cross-cutting; we shipped a LOT that's undocumented)

> Added 2026-06-23: a big body of work landed (the whole dashboard epic, the
> external-access stack, MCP, the IDE extension, custom agents, the publishable
> extension SDK, more providers, etc.) and neither the commercial site nor the
> docs reflect it. Two tracked tasks:

- **DW1 (task #184) — Marketing site (getexcalibur.dev) full refresh** [marketing,
  `~/excalibur` apps/marketing Nuxt]. Update every page + subpage to the shipped
  reality (dashboard, F1–F8, MCP, IDE ext, custom agents, extension SDK, LSP,
  providers, …); kill stale "M1/mock/coming-soon" claims + outdated screenshots;
  fold in the pending site Phases 2–5.
- **DW2 (task #185) — Docs full review + update** [Core, `docs/`]. NEW docs (the
  web dashboard + its `/api` + `--write`/`--share`, an extension-authoring guide,
  a work-items/kanban guide) + UPDATE existing (getting-started, providers,
  security, autonomy-levels, CONTRACT, ROADMAP). **Reframe the README around the
  M-SHELL** — the interactive shell (welcome screen + REPL + `/` commands) is the
  PRIMARY experience, not a flat command list. Reconcile backlog/ROADMAP with the
  live task list; kill dead links + drifted command examples; en (+es where bilingual).

## P0 — Foundational, autonomous, unblock adoption

1. **Execute extension tools inside the agent loop + publish the SDK** [Core][auto] — OC-P0 / M5.
   The `AgentTool` interface exists but the SDK admits "M1 does not execute extension
   tools inside runs yet", and all `@excalibur/*` are `private:true`. Wire `AgentTool`
   into `native-agent-adapter` and un-publish `extension-sdk`. Highest-impact: turns our
   20 contribution types from claimed into real, beating OpenCode's ~5 hooks.
2. **Corporate proxy + CA certs** [Core][auto] — OC-P0. `HTTP(S)_PROXY` / `NO_PROXY` +
   `NODE_EXTRA_CA_CERTS` in the fetch/model/MCP paths. Small code, unblocks every
   proxied enterprise; pairs with our SSRF/redaction lead.
3. **Programmable `serve` backend + ACP server** [Core][auto] — OC-P0 / M7. Read-only
   viewer → control plane (session/prompt/events, OpenAPI) + expose ACP. One investment,
   three gaps: server, ACP (driven by Zed/JetBrains/Neovim), and the base for the IDE ext.
4. **Update the stale M1 docs + roadmap** [Core][auto] — docs. `getting-started.md`,
   `providers.md`, `CONTRACT.md`, `security.md`, `autonomy-levels.md` still describe the
   mock M1 behavior; rewrite to the shipped M2/M3 + F1–F8 reality.

## P1 — Agent ergonomics + reach, autonomous

5. **IDE extension** (VS Code/Cursor/Windsurf) ✅ SHIPPED — new `apps/vscode` package: a
   thin extension that spawns `excalibur acp` and bridges it over ACP (ndjson JSON-RPC).
   Commands (Run / Ask About Selection / Explain File / Review / Cancel / Open Terminal) +
   keybindings + editor context menu; streams assistant text/tool calls/plan to an output
   channel; native permission modals; selection + file passed as prompt context. Builds to
   a single CJS bundle (tsup, `vscode` externalized), `@types/vscode` devDep only. Verified
   end-to-end vs a real model (the AcpClient ↔ real `excalibur acp` ↔ Groq). Adversarial
   review found + fixed 11 real bugs (killRun on teardown, loop-proof receive, EPIPE
   listeners, running-key race, fence injection, refuse-unconfigured). _(Fixed a real
   ACP+serve bug en route: runs defaulted to the `mock` provider — now thread the resolved
   providers.yaml default + refuse when unconfigured; regression-tested.)_ Polish (webview
   UI, deeper ACP verbs, Open VSX/Marketplace publish) → **5b**. [Core/new][auto] — OC-P0.3 / M7.
6. **User custom slash commands** (markdown `/name` with `$ARGUMENTS`/`$1`/`!cmd`/`@file`)
   [Core][auto] — OC-P1. Ours are hardcoded; we already have `{{var}}` templating.
7. **Self-contained custom agents** ✅ SHIPPED — one `.excalibur/agents/<name>.md` =
   persona(body)+role+model+provider+temp+tools-allowlist+permissions. `excalibur
agents list|show|init` + `run --agent <name>`. The allowlist only NARROWS the
   role floor (deny wins); agent permissions union the project denials. _(Interactive
   shell `/agent` selection is follow-up **7b**.)_ [Core][auto] — OC-P1.
8. **Model-callable tools: `edit` · `skill` · `question` · `lsp`** ✅ SHIPPED — `edit`
   (P1.8) surgical find/replace; `lsp` (def/refs/hover), `question` (clarify the
   human, graceful-proceed headless) and `skill` (progressive disclosure: system
   prompt lists project SKILL.md by name, model pulls the body on demand) all in
   P1.8b (7cccf16/80f542d/bda5b01). 19 native tools; all read-only ones gated read-only. [Core][auto] — OC-P1.
9. **Per-edit formatters** (prettier/biome/gofmt/rustfmt, auto on write) [Core][auto] —
   OC-P1. Zero-to-one: we have nothing today.
10. **Widen LSP coverage (5 → ~28 langs) + precise install hints** ✅ SHIPPED — the
    registry now maps ~28 languages to their conventional servers; a missing server
    no longer fails silently — the `lsp` tool surfaces the exact install command.
    [Core][auto] — OC-P2. _(Actual auto-INSTALL execution — running npm/go/rustup
    mid-run, network-gated + opt-in — is split to follow-up **10b**.)_
11. **Per-command bash deny globs** ✅ SHIPPED (476aaac) — `permissions.deniedCommands`
    hard-denies even when allowlisted (deny beats allow), checked before the allowlist.
    [Core][auto] — OC. _(Global user config layer split to **11b**.)_
    11b. **Global user config layer** (`~/.config/excalibur/config.yaml` merged UNDER the
    project; defaults < global < project < env) [Core][auto] — touches `loadExcaliburConfig`.
12. **`stats` (historical token/cost)** + **session export/import** (JSON/Markdown) ✅ SHIPPED
    [Core][auto] — OC.
13. **Custom theme loader** ✅ SHIPPED (022d1e6) — `ui.customTheme` (any subset of the
    14 palette colors, hex) merged over the named theme; applies everywhere via the
    Palette pipeline. [Core][auto] — OC. _(Rebindable keybinds split to **13b**:
    config-driven action→key remap across the 3 input reducers.)_
14. **More providers + in-TUI model picker + reasoning/vision variants** ✅ SHIPPED —
    (a) gateway: `ChatInput.reasoningEffort` + `ChatMessage.images` (vision) + providers.yaml
    `capabilities` (78c6771); (b) catalog +5 providers (Groq/xAI/Cerebras/Together/Fireworks)
    - capability metadata (06dff7c); (c) in-shell `/models` picker reusing Ui.select (b77b8f6).
      [Core][auto] — OC-P2. _(The 4th part "new adapter family" — a native non-OpenAI-wire
      adapter, e.g. Gemini generateContent — deferred to **P2.20** where real provider creds
      enable live verification; Gemini already works via the openai-compat endpoint.)_

## P2 — Roadmap M4/M5 (some need credentials)

15. **M4 GitHub App/Action** (webhook bot: `@excalibur review`/`generate-tests`, triage/PR
    on runners) [Ent/Core][cred] — M4 / OC-P2.
16. **M4 Linear/Jira providers + Discovery remote intake** (`--from-linear/--from-jira/
--from-github-issue`, today stubs) [Core][cred] — M4. _(real `pr-create` already shipped — drives `gh pr create`.)_
17. **M4c Slack/Teams + scheduled agile jobs** (BullMQ daily/weekly; today manual triggers)
    [Ent][cred] — M4c.
18. **M5 extension permission enforcement** ✅ DONE (P2.18, Core): `extensions.enforce`
    hard-block + capability allow/deny, **version locks** ✅, **central skill approval** ✅
    (`skills.approval`). PENDING: **enterprise-managed extensions** + **instruction-source
    audit** [Ent].
19. **Public session sharing** (`/share`→link; manual/auto/disabled) [Core][cred] — OC-P2.
    Needs a hosting decision.
20. **Cloud-enterprise model auth** (Bedrock/Azure/Vertex) [Core][auto] — OC-P2.

## P3 — Enterprise + infra (the `~/excalibur` repo, larger)

21. **M3-Enterprise**: server-side real agent sessions + sandbox (`AgentSession.adapter`,
    `sandboxId`/`worktreePath`) [Ent] — M3.
22. **M5 SSO** (beyond API-key auth) [Ent] — M5.
23. **M6 deploy/scale**: hybrid/self-hosted runners (`Organization.deploymentMode` real)
    [Ent+infra] — M6.
24. **M7 Core↔Enterprise sync maturation + CMUX** (`excalibur cmux` is a stub) [Ent/Core] — M7.
25. **M8 extension install sources** (npm/enterprise registry; `extensions install <npm>`
    is a stub) + **GA / commercial beta** [Core/Ent][cred] — M8.

## Dashboards & Manager Web (designed 2026-06-21) — surfaces OpenCode has NO equivalent of

Two epics covering the developer dashboard (Core) and the manager control-plane web
(Enterprise). Rationale: OpenCode is an individual terminal agent with no work-item
board and no management/governance web at all — these are pure differentiators. The
Enterprise governance **engine** (RBAC, policy, audit, budgets, usage) is already built
and enforced in the API; much of E1–E5 is **surfacing** existing endpoints, not new
backend. Tasks #153–#167, plus the foundational **Epic W** (#169–#174) below.

### Epic W — Work-item-centric core (the spine) — tasks #169–#176

> **NATIVE-FIRST + autonomous.** Excalibur ships its OWN first-party work-item system
> with a lightweight kanban and full CRUD — it works completely standalone, no external
> dependency, for the individual OSS developer AND for teams. External trackers
> (Linear/Jira/GitHub/Slack — M4) are **OPTIONAL** sync layered on top, never required,
> never the foundation. The dev cycle: **plan** (native work-items, Discovery/planning
> refine them) → **execute** (runs/agents linked to a work-item) → **deliver**
> (patches/PRs linked) → **report** (rolled up by work-item) → _(optional)_ **sync**
> to/from a tracker. The M4 integrations are the optional ingest+sync ends of THIS loop.

- **WK1 (#175, P0/P1, FOUNDATION) Native work-item store** — kanban model (status lanes,
  order/rank, priority, sub-tasks, labels, assignee) + full CRUD (create/edit/delete/
  move/reorder). **Persistence (never memory-only):** structured **JSON** files under
  `.excalibur/work-items/WI-<n>.json` (git-able; keep the existing format — JSON mirrors
  the Enterprise Postgres/Prisma `WorkItem` shape for trivial parity/sync; the body is a
  markdown string inside the JSON). Enterprise persists in Postgres/Prisma. Autonomous; spine.
- **WK2 (#176, P1) `work-items` CLI** — full CRUD + a terminal `board` (ASCII kanban);
  autonomous task planning from the CLI, no external tracker. Depends WK1.
- **W0 (#169, P0/P1) Run↔work-item link data model** — optional `workItemId` on run/
  patch/interaction records; `work-items run`/`run`/`patch` persist it; back-links
  exposed. Depends WK1.
- **W1 (#170, P1) Planning-first flow** — `run` create-or-link a work-item; Discovery
  emits/refines work-items as the plan; intent router routes planning → work-item.
- **W2 (#171, P1) Reports/status/insights roll up by work-item.**
- **W3 (#172, P2) Enterprise** — surface the existing link tables (work-item → runs/
  patches/PRs); planning-item → work-item → run; agile board (E7) as the backbone.
- **W4 (#173, P2, OPTIONAL) External tracker sync** — bidirectional, layered on the
  native store (never required): tracker ↔ work-item, run/patch/PR/status → tracker,
  `@excalibur` webhook → run on a work-item. **Gives M4 (#142/#143/#144) their meaning.**

### Epic A — OSS local dashboard, TASK-CENTRIC (`excalibur serve`) [Core][auto]

> **Architecture (firm):** the local dashboard is articulated around **tasks /
> work-items**, NOT a run tracker. Runs are CHILDREN linked to a work-item. The
> HOME is a task board; drilling a work-item shows its associated runs + patches +
> PRs + the live `update_tasks` checklist + plan + discovery. Ad-hoc runs (no
> work-item) sit in a secondary "Unassigned"/Runs tab. (See the
> `dashboard-task-centric` decision memory.) Today's dashboard is run-centric and
> must be reframed.
>
> **STACK (decided 2026-06-22, D0):** the dashboard is a **Svelte 5 + Vite + TS**
> SPA compiled by `vite-plugin-singlefile` to ONE self-contained `index.html`,
> **embedded into the CLI** (the build copies it to `dist/dashboard.html`) and
> served by `excalibur serve` at `/`. One process, no extra setup, framework
> compiles away → small bundle. Supersedes the earlier "vanilla JS" note. Wire
> contracts live in `@excalibur/shared` (`dashboard.ts`); the server maps domain
> → DTO in `apps/cli/src/lib/dashboard-data.ts`.

- **D0 (P1, foundational) Run↔work-item link + task-first IA — ✅ DONE (ac6c994).**
  `RunRecord.workItemId` + `runsForWorkItem` already existed (W0); D0 added the
  web layer: shared dashboard contracts, the `apps/dashboard` Svelte SPA skeleton
  (task-first nav: Board/Runs/Insights/Plans + work-item drill-down), the serve
  endpoints `GET /api/board` + `GET /api/work-items/:key`, and the embed pipeline.
  Verified e2e vs a real `excalibur serve`. Everything else in Epic A builds on this.
- **D1 (P1) Task/work-item board (the HOME) — ✅ DONE (2a031ad).** Kanban columns
  by lane; cards show the active run's live `update_tasks` checklist (progress bar
  - ✓/▸/○), an "active" pulse, auto-refresh. + adversarial review of D0+D1 (18
    findings fixed, 40b9c0a).
- **D2 (P1) Interactive board actions — ✅ DONE (2300b6a).** Drag-to-change lane,
  start-run-on-card, cancel/approve runs from the browser — all behind
  `excalibur serve --write` (GET /health reports `write`; POST /api/work-items/:key/move
  - workItemId on POST /api/runs).
- **D3 (P1) Plan & Discovery — ✅ DONE (de518d4).** Plans list (expand to read the
  markdown body) + Discovery readiness cards, via new core `listPlans`/`readPlan`
  - `GET /api/plans`, `/api/plans/:id`, `/api/discovery`.
- **D4 (P2) Runs explorer + cost/token charts — ✅ DONE (85fd97f).** Insights page
  (stats + cost-by-day + by-model/workflow, inline SVG, no chart lib) + a live
  filter on the runs explorer.
- **D5 (P2) Live SSE + read-only share link — ✅ DONE (972ce7a).** `GET /api/board/stream`
  pushes board snapshots on change (browser drops the poll); `serve --share` mints
  a READ-ONLY token (GETs ok, all mutations 403, /health write:false) + prints the URL.
  Copy-link button on the board.

> **Epic A (OSS dashboard D0–D5) COMPLETE — 2026-06-23, all on `main`, CI green.**
> Stack: Svelte 5 + Vite single-file SPA embedded in the CLI, served by `excalibur serve`.

### Epic B — Enterprise manager web, advanced screens (`apps/web`) [Ent]

- **E1 (P2) Team management UI** — teams CRUD + members + per-team budgets (API exists).
- **E2 (P2) User & role administration UI** — users + role assignment (API + MinRoleGuard
  exist; UI missing).
- **E3 (P2) Org settings UI** — plan / deploymentMode / budget / defaults (API GET/PATCH exists).
- **E4 (P2) Policy authoring UI** — create/edit/delete + simulate policies (engine real; UI
  read-only today).
- **E5 (P2) Advanced cost & usage analytics** — time-series, per team/repo/model/user, budget
  burn-down + forecast, CSV export.
- **E6 (P2/P3) Team performance & delivery tracking** — throughput, approval latency, success
  rate, patches merged, cost-per-outcome.
- **E7 (P2/P3) Agile Kanban board + sprint model** — drag-drop board, swimlanes by team/sprint;
  add first-party Sprint/Board Prisma models (today sprint is a mirrored string).
- **E8 (P2) Scheduled agile jobs + schedule config UI** — repeatable BullMQ daily/weekly +
  Slack/Teams delivery + settings UI. Extends M4c (#144) with scheduler + UI.
- **E9 (P2/P3) Approvals/governance manager inbox** — cross-team queue, bulk actions,
  SLA/escalation.
- **E10 (P3) Compliance & audit views** — SIEM export + signed Compliance Pack from the Claim
  Ledger + advanced audit filters.

## Explicitly NOT doing

- **Hosted model subscription** (à la OpenCode Zen/Go) — deliberate: pure BYOK, no
  subscription OAuth (see the `subscription-auth` decision).

---

## Recommended attack order

P0.1 → P0.2 → P0.4 (docs) → P0.3 → then P1.5 (IDE, on top of ACP) and P1.6–9
(commands/agents/tools/formatters) → P2 as credentials allow. The P0 set closes the
most embarrassing gaps (real extensibility, enterprise-deployable, editor-embed)
**without diluting our moats** (free web/research, SSRF floor, signed/sandboxed MCP,
worktree swarm, path/role routing, time-machine, budget cap, es i18n).
