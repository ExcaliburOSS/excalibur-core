# Changelog

All notable changes to Excalibur Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.0] - 2026-06-27

The **shell-parity & live-rail polish** release. The headline: the conversational
m-shell is now a _friendlier interface to the SAME engine_ as the direct
commands — a build you type in the shell runs the full **gated workflow** (the
complexity-sized Plan → Implement → **Verify** → **Review** → PR phases, the
adversarial **verification mesh** and the **claim ledger**), exactly like
`excalibur run`, never a degraded single loop. Plus a wave of fixes to the live
run rail and the post-turn receipt.

### Added

- **The m-shell runs the gated workflow engine.** A build (or a single direct
  code change) typed into the interactive shell now flows through the same
  `selectWorkflow → executeLocalRun` pipeline as `excalibur run`: the
  complexity-sized workflow, its Verify/Review phases, the verification mesh and
  the claim ledger all run — wrapped in the conversational rail, live narration,
  inline approvals and the warm receipt. Previously a shell build ran a bare
  single agent loop with no phases or gates. Real-Kimi verified end to end
  (`scripts/verify-mshell-gated.mjs`).
- **New `edit` intent.** The intent router now distinguishes a pure question
  (`chat`, a conversational turn) from one small direct code change (`edit`,
  routed through the gated engine) — so even a quick change in the shell gets the
  same tests/typecheck/verify quality as the CLI.
- **Default engineering-quality bar in the agent prompt.** Every build now holds
  to a production bar by default: real project structure with concerns separated
  into their own files/modules (not one monolithic blob), idiomatic code,
  accessible/usable UX, and _verify it actually builds/runs_ before declaring
  done. Real-Kimi verified ("build a landing page" now yields a structured
  `index.html` + `styles/` + `scripts/`, not a bare inline file).
- **Animated live rail.** The in-progress action and the active phase header
  pulse an accent crest left→right (Claude-Code-style), so the live line reads as
  "happening now".

### Changed

- **Diffs peek by default.** The most-recent change shows the first lines of its
  diff inline (up to ~25, capped to the terminal height) instead of a "press
  space to expand" stub.
- **The live "Working" tail collapses.** The active phase shows only its
  most-recent actions behind a "⋯ N earlier" indicator, so the breathing header
  never scrolls off the top — and the header reads warmly ("Working on your
  task…") rather than a bare "Working".

### Fixed

- **A successful turn no longer renders as a red error.** A backgrounded dev
  server (`… &`), a user-denied/skipped command, an interrupt/terminate signal,
  or an unknown exit code is no longer mistaken for a failed check that flipped
  the whole turn to a red ✗. Genuine failures (incl. crash signals) still fail.
- **"exit 0" is never shown** — a green ✓ already says the command passed.
- **The live region no longer erases the scrollback above it, and the TUI no
  longer flickers** — both were the same Ink "dynamic region taller than the
  viewport" bug, fixed by bounding the live region to the terminal height.

## [1.6.0] - 2026-06-27

The **planning overhaul** release: Excalibur's plans go from prose to a
structured, durable, trackable, recallable artifact — world-class for very large
multi-phase projects — and the live dashboard gains the plan tree, the agile
backlog, and the sprint burndown.

### Added

- **Structured plans (source of truth).** An approved plan is now a structured
  model — phases → steps with per-step status, dependencies, and acceptance — saved
  as a `<id>.plan.json` sidecar alongside the human `.md`. Everything below builds
  on it.
- **Durable resume-at-step.** A large multi-phase plan executes step by step, each
  step checkpointed to disk, so an interrupted run (Ctrl-C, a crash, closing the
  laptop) resumes at the next unfinished step instead of redoing everything. The
  shell proactively offers to pick an unfinished plan back up at launch, and
  `excalibur plans resume [id]` resumes on demand.
- **Live plan tree.** A breathing plan ribbon is pinned above the run rail in the
  TUI (phases → steps with live status and a done/total roll-up), and the dashboard
  Plans view renders the same tree with a progress bar, a "next step" marker, and a
  "resumable" badge.
- **Plans become work-items.** Approving a plan materializes it into the kanban: the
  plan becomes an **epic**, each step a sub-task, and each step's dependencies become
  first-class **`blockedBy`** edges between work-items. The board live-tracks
  execution as steps run. `excalibur plans tasks [id]` materializes on demand.
- **Advanced backlog — sprints, estimates, burndown.** Work-items gain a story-point
  `estimate`; a new sprint store time-boxes work; `excalibur sprints`
  (list/create/start/complete/assign/show) drives it from the terminal with an ASCII
  burndown, and the dashboard adds a Sprints view with an SVG burndown chart.
- **Richer plan memory.** A finished plan now writes a structured, recall-friendly
  memory — outcome digest plus the **files it touched** as the relevance key — so an
  executed plan primes future work on the same files (the old capture was never
  recalled). Partial/blocked plans are remembered too.
- **Structured re-plan diff.** `excalibur plans diff [idA] [idB]` shows what changed
  between two plan versions — steps added/removed/renamed/moved — matched by title so
  an inserted step doesn't read as "everything after it changed".

### Changed

- **`excalibur serve` leads with the dashboard.** The startup banner now headlines
  the clickable dashboard URL in the Cobalt sword-blue accent
  (`◆ Excalibur Live Dashboard: <url>`).

## [1.5.0] - 2026-06-27

A conversational-shell + reach release: the agent can work across directories,
never leaves you watching a silent cursor, and the prompt gains a real command
menu.

### Added

- **Work across directories.** The agent is no longer confined to the working
  directory: `read_file` / `list_files` can read anywhere (a sibling project, an
  absolute or `../` path), and `write_file` / `edit` / a command's working
  directory can change other directories too. **Out-of-tree writes are confirmed
  first** at the permission gate (allowed on approval); secret files (`.env`,
  keys, credentials) are still refused and the destructive-command floor +
  `O_NOFOLLOW` leaf guard stay hard.
- **A `/` command menu.** Typing `/` lists every command with a brief
  description and filters as you type; ↑/↓ highlight a row and Tab/→ autocompletes
  it. Replaces the old model-powered ghost autocomplete.
- **A contextual placeholder** — a dim hint inside the empty prompt that adapts to
  context (a first-run invitation vs. a follow-up hint) and disappears as you type.

### Changed

- **Always-on narration.** A pulsing "thinking" indicator with rotating, friendly
  status phrases now covers every previously-silent wait (understanding the
  request, shaping a plan, mapping scope, breaking work into steps), and the
  narration guidance mandates continuous, plain-language narration — never a
  silent cursor.

### Fixed

- **The up-arrow no longer duplicates the line.** The raw line editor clears its
  full (wrapped) multi-row block on each repaint instead of a single row.
- More user-facing copy reworded from "run" to "task" / "execute the task".
- Removed a stray black line across the welcome sword's blade.

## [1.4.1] - 2026-06-27

A conversational-shell polish release — the m-shell now talks like a
pair-programmer, never leaks internal "run" machinery, and its intelligence can
no longer be silently disabled.

### Fixed

- **The shell's intelligence is never silently off.** Intent routing — the gate
  that sends a turn to plan / swarm / scope / mission instead of a plain turn —
  required a separate fast model; with a single model configured it quietly fell
  back to "always a plain turn", so scope estimation and plan-shaping never ran.
  It now falls back to the default model (with a reasoning-aware budget) so the
  routing always works. Verified across EN/ES/FR.
- **`exit` / `quit` leave the shell.** A bare `exit`/`quit` was treated as a task
  and handed to the model; it now exits, as in every REPL.
- **No stray git error on a fresh repo** — `fatal: ambiguous argument 'HEAD'` no
  longer leaks on a repository with no commits.

### Changed

- **The conversational turn leads with narration, not run scaffolding.** Dropped
  the `→ agent · act · L4` header, the internal run id/path line, and the
  `run completed` line from chat/plan/build turns — the warm narration, the live
  action lines (file paths + diffs stay) and the post-turn receipt carry it.
  Plan/build phases read as `◇ Planning…` / `◆ Making the changes…`.
- **Talk tasks, not "runs".** "run" is internal; user-facing output across the
  shell, the `run`/`patch` command and replay now says **task** (en + es).
- **Slimmer live footer in the shell** — just time · tokens · cost, dropping the
  level/safety/push/model telemetry (the `excalibur run` command keeps the full
  footer).
- **Status-line safety reflects the real posture** — when auto-accept is on it
  says so, instead of always claiming "no files will be modified without approval".

## [1.4.0] - 2026-06-26

The work-item dashboard minor — the local board becomes a real command center.

### Fixed

- **The local dashboard now serves the work-item board, not a legacy run page.** A
  symlink path-resolution bug meant every globally-installed CLI fell back to an old
  run-centric page; `excalibur serve` (and the m-shell's auto-dashboard) now reliably
  serve the embedded Svelte work-item kanban, with an honest "not built" page as the
  only fallback. The legacy inline run dashboard is removed.

### Added

- **A work-item command center in the local dashboard.** Create work items (a `+ New`
  panel and per-lane quick-add), edit them (title · description · lane · priority ·
  assignee · labels), delete, comment, and author a checklist (acceptance criteria /
  subtasks) — all from the UI, over a write-gated `/api/work-items` surface.
- **The m-shell's auto-started dashboard is now interactive** (writable), so you can
  manage work items and start runs right there. It stays localhost-bound + per-session
  token-gated; `EXCALIBUR_DASHBOARD=read-only` opts down, `=off` disables.

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
