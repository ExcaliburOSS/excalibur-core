# Excalibur — Master Roadmap (M1–M8) + Competitive Backlog

> **Why this file exists.** This is the canonical production roadmap for Excalibur
> (both repos). It was reconstructed on 2026-06-19 after the original approved
> plan — which lived only in an ephemeral `~/.claude/plans/*.md` scratch file —
> was lost when that filename was reused for a later task. **The master plan now
> lives in git so it cannot be lost again.** Keep it updated as milestones land.
>
> Two repos: **Excalibur Core** (`~/excalibur-core`, OSS, Apache-2.0 — CLI +
> `@excalibur/*` packages) and **Excalibur Enterprise** (`~/excalibur`, private —
> NestJS api + BullMQ worker + Nuxt web + Prisma db). Enterprise consumes Core.

---

## Two numbering systems (and how they relate)

- **OSS-0 … OSS-11** — fine-grained _build phases_ of Core (from `docs/spec/oss-spec.md §19`):
  OSS-0 skeleton · OSS-1 config/init · OSS-2 workflow+methodology schema ·
  OSS-3 local artifacts/events · OSS-4 model gateway · OSS-5 lightweight interactions ·
  OSS-6 patch generation · OSS-7 native agent runtime · OSS-8 local agentic runs ·
  OSS-9 GitHub CLI (`pr`) · OSS-10 CMUX · OSS-11 enterprise-sync hooks.
- **M1 … M8** — coarse _production milestones_ spanning BOTH repos. The single
  authoritative enumeration is the roadmap line in `~/excalibur/README.md`:
  > M1 foundations(mock) · **M2** real AI · **M3** real agents + sandbox ·
  > **M4** GitHub/work-items (·M4b Linear/Jira ·M4c Slack/agile) ·
  > **M5** governance/SSO · **M6** deploy/scale · **M7** IDE/sync/CMUX ·
  > **M8** commercial beta.
- **Bridge:** M1 = OSS-0→OSS-3 + the mock loop. M2 = OSS-4 (real providers) +
  the real native tool loop. M3 = OSS-7/OSS-8 (native agent runtime + agentic
  runs, real execution) + custom-command external agents. OSS-9 (`pr`)≈M4,
  OSS-10 (CMUX)≈M7, OSS-11 (sync) spans M1→M7.

There is also a **third track** — the **P0/P1/P2 "superación competitiva"
backlog** (below) — which is _not_ M-numbered. Most recent work lives there; it
advanced the product well beyond M3.

Status legend: ✅ done · 🟡 partial · 🔴 pending · (Core / Ent = per repo).

---

## The 8 production milestones

### M1 — Foundations + mock loop ✅ DONE (Core + Ent)

Everything scaffolded and end-to-end on a deterministic **mock** provider; no real
model calls, no real file mutation, commands `simulated:true`.

- **Core:** full command surface (init, run, ask/explain/review, patch lifecycle,
  daily/weekly-plan, Discovery, extensions, onboarding); event stream + RunManager;
  single self-contained CLI bundle.
- **Ent:** NestJS api + worker + Nuxt web + Prisma db monorepo; multi-tenant
  orgs/users/teams/repos + RBAC; AssistantInteractions, PatchRequests, AgentRuns
  (mock); Policy engine + Audit + AES-GCM secret encryption.

### M2 — Real AI ✅ DONE (Core ✅ · Ent ✅ gateway slice)

Real model providers replace the mock.

- **Core ✅:** real adapters (`anthropic`, `openai-compatible`/vLLM/custom, `ollama`)
  wired via `CORE_PROVIDER_FACTORIES`; streaming, cost, redaction, retry/timeout;
  real repo-context in ask/review; real patch apply; compaction summarizer;
  providers-as-extensions (EXT-6); i18n architecture (en+es); Knowledge Compounding
  (`.excalibur/memory/`).
- **Ent ✅:** production per-org `ModelGateway` (AES-GCM key decrypt, pre-flight
  budget, single-hop fallback, sanitized logging).

### M3 — Real agents + sandbox ✅ DONE (Core) · 🔴 PENDING (Ent)

Real agentic execution.

- **Core ✅:** native chat→tool loop (real `spawn`/atomic writes, permission-gated,
  bounded); **swarm** fan-out/fan-in over isolated git worktrees (+ `excalibur swarm`
  - in-shell `/swarm` + grader `--grade`); **per-session Docker sandbox** (network
    none, no host secrets); **LSP** per-edit diagnostics fed to the loop; **MCP** client
    (stdio + Streamable-HTTP) wired into the loop; custom-command adapter.
- **Ent 🔴:** server-side real agent sessions + sandbox (`AgentSession.adapter`
  native/claude_code/codex/aider/opencode, `sandboxId`/`worktreePath`) NOT shipped —
  Enterprise still tracks Core M2 + event-sync compatibility.

### M4 — GitHub / work-items 🟡 PARTIAL

Real external ticket↔code integration. Sub-phases: **M4** GitHub · **M4b** Linear/Jira

- status-sync/PR-linking · **M4c** Slack/Teams + agentic-agile scheduling.

* **Done:** Core `excalibur work-items list/show/run/comment` over the real `gh` CLI
  (`GitHubCliProvider`, P2.9).
* **Pending:** GitHub **App** (webhook `@excalibur review`/`generate-tests`); Discovery
  remote intake `--from-linear/--from-jira/--from-github-issue` (honest stubs today);
  OSS Linear/Jira providers (none in `packages/work-items`); `pr-create` (stub);
  M4c Slack/Teams provider + BullMQ scheduled daily/weekly jobs (Ent: manual triggers
  only today).
* **Blocks:** needs GitHub App credentials, Linear/Jira API keys, Slack app.

### M5 — Governance / SSO 🟡 PARTIAL (Core governance done; SSO + Enterprise pending)

- **Extension permission enforcement** ✅ (Core, P2.18) — `config.extensions.enforce`
  turns `validatePermissions()` warnings into a hard block _before_ the entrypoint
  loads, with capability allow/deny lists. **Version locks** ✅ and **central skill
  approval** ✅ (`config.skills.approval`) shipped alongside.
  _(NB: the **agent** runtime already hard-blocks via `PermissionEngine` — separate
  from this extension-manifest enforcement.)_
- 🔴 PENDING: **SSO** (beyond API-key auth); **enterprise-managed** (org/team)
  extensions; per-run instruction-source audit + precedence enforcement — all
  Enterprise-side.

### M6 — Deploy / scale 🔴 PENDING (Enterprise + infra)

Customer-managed / **hybrid runners**, self-hosted deployment
(`Organization.deploymentMode` cloud/hybrid/self_hosted becomes real). Needs infra.

### M7 — IDE / sync / CMUX 🔴 PENDING

IDE integrations (`AssistantInteraction.source` vscode/jetbrains), Core↔Enterprise
**sync maturation** (M1 ships an ingestion endpoint + Core keeps the event-compat
maps current), and **CMUX** integration (`excalibur cmux` is an honest stub today,
OSS-10).

### M8 — Commercial beta 🟡 PARTIAL (packaging done, not published)

- **Done:** CLI fully packaged (`bin: excalibur`, zero-runtime-dep self-contained
  bundle: `dist/main.js` CJS + `dist/ink-ui.mjs` ESM, `prepublishOnly` build).
- **Pending:** actual **npm publish** (registry returns 404; still `0.1.0`) — needs
  npm auth + explicit go-ahead; npm/enterprise-registry as extension install sources
  (`extensions install <npm>` is an M8 stub); GA/commercialization.

---

## Track 3 — Competitive "superación" backlog (P0/P1/P2) — NOT M-numbered

Reconstructed from `project-excalibur-competitive-audit` memory. This is where most
2026-06-17→19 work went; it lifts the product past table-stakes vs Claude Code /
OpenCode. **Nearly all shipped.**

- **P0 — `run` real** ✅ (de-mocked; `verify:real` 31/31 vs Kimi).
- **P1 visual** ✅ — flicker-free → **full Ink TUI migration** (run + shell + swarm
  lanes; 7 phases); real **diff viewer** (gutter + word-level + side-by-side); **theme**
  system (daltonized/high-contrast); live swarm lanes.
- **P1 functional** ✅ — **LSP** per-edit + review/patch grounding; **MCP** remote
  (Streamable-HTTP); **headless** (`run --output-format json/stream-json`,
  `ask --json-schema`); **`serve`** + web dashboard (HTTP+SSE).
- **P2** ✅ (mostly) — **grader/rubric** loop (`swarm --grade`); **hard budget cap**;
  **Claim Ledger**; **Verification Mesh**; **insights**; Knowledge Compounding.
- **P2 — since shipped (2026-06-20→21)** ✅ — **background/fleet** (`/bg` + `/threads`,
  Tab-cycle concurrent sessions); **MCP OAuth/DCR** + **Ed25519-signed registry**;
  the entire **F1–F8 external-access epic** (governed network + SSRF · web_fetch ·
  free web_search SearXNG→DuckDuckGo · web_extract/web_crawl · opt-in local browser ·
  hosted readers BYOK · native cited research + intent route · anti-injection +
  provenance) — all in **1.2.0** (published to npm).
- **P2 still open** 🔴 — **VS Code/IDE extension**; ACP server; programmable `serve`
  backend; see `docs/backlog.md`.

---

> **Update 2026-06-21:** the F1–F8 external-access epic, MCP OAuth/DCR + signed
> registry, background/fleet, and the onboarding overhaul all SHIPPED in **1.2.0**
> (published to npm). The full prioritized, deduplicated backlog of what remains —
> merged with the OpenCode feature-gap analysis — now lives in **`docs/backlog.md`**.
> Headline open items: real extension-tool execution + SDK publish, corporate
> proxy/CA, programmable serve + ACP, IDE extension, M4 (GitHub App/Linear/Jira/Slack),
> and the Enterprise milestones (M3-Ent, M5 SSO, M6 runners, M7 sync/CMUX, M8 GA).

## Current state (2026-06-23) and what remains

**Done:** M1 ✅ · M2 ✅ · M3 ✅ (Core) · the entire P0/P1/P2 competitive track ✅
including background/fleet (`/bg`, `/threads`, swarm). Also shipped in Core:
the external-access stack (web_fetch/web_search/MCP, 1.2.0), the IDE extension,
self-contained custom agents, the in-shell model picker + 5 new providers,
**extension permission enforcement + version locks + skill approval** (M5
governance for OSS), the OSS dashboard epic (D0–D5, `excalibur serve`), the
native work-item store + kanban, and the published `@excalibur-oss/excalibur`
and `@excalibur-oss/extension-sdk` packages on npm. The Core product is real,
hardened, ~1800 unit tests green, `verify:real` green vs real Kimi.

**Remaining, by what blocks it:**

- **Needs your credentials / a go-decision:** M4 (GitHub App, Linear/Jira remote
  intake, Slack/Teams), cloud-enterprise model auth (Bedrock/Vertex), the VS Code
  Marketplace publish, and the hosted public-share decision. (Azure OpenAI already
  ships; npm publish is done.)
- **Enterprise + infra (the `~/excalibur` repo):** M3-Enterprise (server-side real
  agents+sandbox), M5 **SSO** (extension enforcement already ships in Core),
  M6 (hybrid/self-hosted runners), M7 (sync maturation + CMUX), the Manager web
  (E1–E10).

> **Process fix:** the master plan must always live here (`docs/ROADMAP.md`), in git —
> never only in an ephemeral plan-mode scratch file.
