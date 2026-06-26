# Changelog

All notable changes to Excalibur Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-06-26

The orchestration & autonomy minor: Excalibur now interprets a big goal, maps
the codebase before it plans, drives a multi-step mission to completion, and
lets you steer it live — while narrating the whole way.

### Added

- **Meta-orchestrator (missions)** — give Excalibur a large goal in plain
  language and it auto-composes a **capability DAG**
  (understand → plan → parallelize → explore → verify → ship), then drives it
  with an adaptive supervisor that re-plans as it learns, **checkpoint/resume**,
  and budget/time governance. Big goals engage it **proactively** (no command),
  with a live **plan ribbon** pinned above the run rail. Each capability is
  backed by the real engine — `parallelize` → the swarm, `explore` → best-of-N,
  `verify` → the Verification Mesh, `ship` → a real pull request — and its gates
  are grounded in real run events, not model prose.
- **Understand-first scope engine** — a read-only, auto-dimensioned exploration
  fan-out that maps a task (relevant files/subsystems, what exists vs. what's
  missing, risks and open questions) **before** planning or building. Available
  as `excalibur scope <task>` (`--json`/`--angles`/`--complexity`), as a natural
  `scope` intent, as a dashboard **Scope** view (`/api/scope`), and — the
  differentiator — **proactively** to ground plan-shaping's questions and the
  planner in real code on large tasks (opt out with `EXCALIBUR_AUTO_SCOPE=off`).
- **Plan-shaping** — before a large or unclear build, Excalibur asks a few
  clarifying questions and offers **multi-select recommendations** to co-create
  the plan (CC/Cursor-style), with the questions/recommendations tailored
  dynamically by the model and grounded in the scope map. Silent on small, clear
  tasks. Also surfaced as a dashboard panel.
- **Live interruptions** — type to Excalibur **during** a run: an interrupt
  triage classifies what you mean, an independence check decides parallel-vs-pause
  for a new request, a routing planner acknowledges instantly, and paused threads
  can be switched to and resumed.
- **Autonomous scheduler & proactive background** — schedule jobs on an
  interval, at a time, or by cron (`schedule` + a dashboard **Scheduler** view);
  the background fleet can **chain** (react-on-completion), a completion
  supervisor can react to a finished run, and background/scheduling are reachable
  by natural language, not just commands.
- **Conversational narration** — the agent narrates its work like a
  pair-programmer: warm, first-person, concise prose between actions, surfaced
  live in the run rail and **streamed token-by-token** as the model thinks
  (openai-compatible providers), with a graceful non-streamed fallback. Narrates
  in the user's own language.
- **Destructive-command safety floor** — catastrophic/irreversible shell
  operations (`rm -rf`, force push, `git reset --hard`, `git clean -f*`, `sudo`,
  `mkfs`, `dd of=/dev/*`, …) are hard-denied regardless of allowlist or approval,
  even under auto-accept/`--yes`. A deliberate per-command allowlist opt-in lifts
  it; a broad `*` does not.
- **Recoverable autonomous runs** — a dirty-tree nudge, a restore point, and a
  rollback hint so an unattended run is never a one-way door.
- **Dashboard, expanded** — new **Sessions** (read-only transcripts),
  **Scheduler**, background **Threads**, a per-run **detail + diff/patch
  viewer**, **global search** across runs and work-items, and a live **budget
  meter** with run-done / approval-pending notifications. Responsive/mobile
  layout, all on a shared read-only `--share` token surface.

### Changed

- **Cobalt theme** — a canonical sword-blue palette and motion vocabulary across
  the Ink TUI (cursor, status gauge, rail gradient) and the web dashboard, so the
  two surfaces match.
- **Context compaction overhaul** — fast-model default, background + silent
  auto-compaction, real-token trigger with reactive overflow→compact→retry, a
  `ctx NN%` status indicator, and a deterministic fidelity guard. Plus **in-turn
  compaction** so a single long agentic turn never overflows the context window.

### Security

- **Path-traversal hardening** on the dashboard detail routes — a percent-encoded
  `..%2F..` can no longer escape the sessions/plans/missions store dirs through
  the read-only share token (now rejected with `400`).

### Infrastructure

- **npm Trusted Publishing (OIDC)** — releases publish from a tag via a
  short-lived GitHub OIDC credential with provenance attestation; no long-lived
  `NPM_TOKEN` lives in the repo. Plus OSS hygiene: `SECURITY.md`, issue/PR
  templates, `CODEOWNERS`, Dependabot, and third-party license notices.

## [1.2.0] - 2026-06-21

### Added

- **External access (F1–F8)** — free, governed web access by default:
  `web_fetch`, `web_search` (local SearXNG → DuckDuckGo), a native multi-source
  research pipeline with cited/verified sources, an opt-in local browser for
  JS-heavy pages, hosted readers (BYOK), and first-class MCP (stdio + Streamable
  HTTP, OAuth/DCR, an Ed25519-signed server registry). All behind a network
  policy, an always-on SSRF floor, and prompt-injection scanning with provenance.
- **Onboarding overhaul** — arrow-key + type-ahead model picker (Kimi / MiniMax /
  GLM lead), paste-the-API-key (masked) into a `0600`
  `~/.config/excalibur/secrets.env`, zero-friction first run with an automatic
  connection test, and smart project-location handling (`excalibur new`,
  create-or-use-here when run anywhere).

## [1.1.0] - 2026-06-20

### Added

- **Background fleet** — `/bg <task>` runs a turn in its own recorded run while
  the prompt stays free (quiet, auto-approved; blocked paths still denied), with
  a one-shot banner on completion; `/threads` lists the fleet and the status line
  shows the active count.
- **Conversational intent router** — a natural-language line is routed to
  plan / swarm (offered) / background (offered) / a direct turn, with no arcane
  commands. Engages only with a real model on an interactive TTY at an
  act-capable level; goes direct under auto-accept and on piped/CI/mock paths.
  Opt out with `EXCALIBUR_ROUTER=off`.
- **Knowledge-compounding read side** — captured project memory (decisions,
  rejections, risks, conventions) is now re-injected into conversational turns,
  relevant to the working set and the paths named in the task.
- **CC-style run rule** above the prompt naming the running background run.
- Generated `.excalibur/instructions/*.md` are localised to the active locale
  (en/es); `AGENTS.md` stays English as a cross-tool standard.

### Changed

- **Redesigned welcome** — full-width accent frame, mixed-case `Excalibur` title
  with a blue→cyan gradient + dim version cutting the top border, the brand
  epigraph, and a crisp quadrant-pixel sword.
- **Autonomy now defaults to L4** (full agentic) — onboarding writes
  `autonomy.default: 4` and the runtime falls back to it.

### Fixed

- Under auto-accept the router goes direct, preserving the zero-prompts contract.
- A Prettier pre-commit hook auto-formats staged files so `format:check` can't
  fail on a missed `pnpm format` (developer experience).

## [1.0.0] - 2026-06-19

The first public release. Highlights of what Excalibur Core does today:

### Agentic core

- Real **model gateway** — `anthropic`, `openai-compatible` (incl. vLLM/custom),
  and `ollama` adapters, with streaming, real token/cost accounting, retries,
  timeouts, and secret redaction. A built-in deterministic **mock** provider is
  the zero-config, offline default.
- Real **native agent loop** — model→tool loop (read/write/search/run/patch/…),
  path-confined to the working directory, gated by the Permission Engine and
  inline approvals.
- **Swarm** fan-out/fan-in — independent subtasks run as parallel agents in
  isolated git worktrees, with a `--grade` revise-until-it-passes rubric loop.
- Per-session **Docker sandbox**, **LSP** per-edit diagnostics fed back to the
  agent, and **MCP** client (stdio + Streamable-HTTP) wired into the loop.

### Experience

- **Ink TUI** — a live, flicker-free run rail with inline syntax-highlighted
  diffs, themes (incl. daltonized / high-contrast), and live swarm lanes.
- **Time machine** — `rewind`/`replay` scrubber + fork-from-cache from any step.
- **Verification Mesh** + **Claim Ledger** — adversarial, evidence-linked quality
  gates over a run's changes.
- **Discovery**, **Knowledge Compounding** memory, structured workflows +
  methodologies, **ISD** instruction ingestion, **insights**, a read-only web
  dashboard (`serve`), and headless output (`run --output-format json`,
  `ask --json-schema`).
- Real **pull requests** via the GitHub CLI (`pr-create`), real GitHub work-items
  (`work-items`), and bilingual (en/es) CLI chrome.

### Notes

- Published to npm as
  [`@excalibur-oss/excalibur`](https://www.npmjs.com/package/@excalibur-oss/excalibur)
  — `npx @excalibur-oss/excalibur` (see [README](README.md)).
