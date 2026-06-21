# Excalibur — Prioritized backlog (post-1.2.0)

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
overhaul · **npm publish 1.2.0** (`@excalibur-oss/excalibur`, `latest`).

---

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

5. **IDE extension** (VS Code/Cursor/Windsurf) [Core/new][auto] — OC-P0.3 / M7. Launch
   hotkeys + selection/`@File#L37-42` passing; rides on the ACP/serve work (P0.3).
6. **User custom slash commands** (markdown `/name` with `$ARGUMENTS`/`$1`/`!cmd`/`@file`)
   [Core][auto] — OC-P1. Ours are hardcoded; we already have `{{var}}` templating.
7. **Self-contained custom agents** (one `.md` = mode+model+temp+prompt+tools+permissions)
   [Core][auto] — OC-P1. Today `role_definition` is description-only.
8. **Model-callable tools: `edit` (surgical find/replace), `skill` (lazy-load),
   `question`, `lsp`** [Core][auto] — OC-P1. `edit` saves tokens vs full rewrite;
   `skill` gives progressive disclosure; `lsp`/`question` give defs/refs + clarifications.
9. **Per-edit formatters** (prettier/biome/gofmt/rustfmt, auto on write) [Core][auto] —
   OC-P1. Zero-to-one: we have nothing today.
10. **Auto-install LSP servers + widen coverage** (5 → ~28 langs) [Core][auto] — OC-P2.
    Turns our (superior) LSP-in-loop integration into an asterisk-free win.
11. **Global user config layer + per-command bash deny globs** (last-match-wins)
    [Core][auto] — OC. Today: project-file only + flat allowlist.
12. **`stats` (historical token/cost)** + **session export/import** (JSON/Markdown/sanitize)
    [Core][auto] — OC.
13. **Rebindable keybinds + custom theme loader** [Core][auto] — OC. Today single-key
    fixed, 5 themes, no loader.
14. **More providers + in-TUI model picker + reasoning/vision variants** [Core][auto] —
    OC-P2. From 3 families to a broad catalog; interactive `/models`.

## P2 — Roadmap M4/M5 (some need credentials)

15. **M4 GitHub App/Action** (webhook bot: `@excalibur review`/`generate-tests`, triage/PR
    on runners) [Ent/Core][cred] — M4 / OC-P2.
16. **M4 Linear/Jira providers + Discovery remote intake** (`--from-linear/--from-jira/
--from-github-issue`, today stubs) + **real `pr-create`** [Core][cred] — M4.
17. **M4c Slack/Teams + scheduled agile jobs** (BullMQ daily/weekly; today manual triggers)
    [Ent][cred] — M4c.
18. **M5 extension permission enforcement** (WARN-only → hard-block), **version locks**,
    **enterprise-managed extensions**, **central skill approval**, **instruction-source
    audit** [Core/Ent] — M5 (Core parts [auto]).
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
backend. Tasks #153–#167.

### Epic A — OSS local dashboard completion (`excalibur serve`) [Core][auto]

- **D1 (P1) Task Kanban board** — columns Pending / In-progress / Done fed by live
  `task_update` events + local work-items (`.excalibur/work-items/*.json`) + plan-mode
  plans. Read-only first. Vanilla JS (keep the zero-dep self-contained bundle). _(This is
  the kanban the dashboard was always meant to have.)_
- **D2 (P1) Interactive board actions** — drag-to-change status, approve gates, start/cancel
  runs from the browser. **Blocked by P0.3** (needs the programmable serve write API).
- **D3 (P1) Plan & Discovery views** — plan-mode plans + Discovery readiness cards.
- **D4 (P1) Runs explorer + cost/token charts** — filter/search/compare runs; historical
  time-series (ties P1.12 `stats`).
- **D5 (P2) Live SSE + read-only share link** — consume `/stream` (drop the 4s poll); optional
  read-only share token.

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
