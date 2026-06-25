# Changelog

All notable changes to Excalibur Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Conversational narration** — the agent now narrates its work like a
  pair-programmer: warm, first-person, concise prose between actions, surfaced
  live in the run rail and **streamed token-by-token** as the model thinks
  (openai-compatible providers), with a graceful non-streamed fallback. Narrates
  in the user's own language.
- **Destructive-command safety floor** — catastrophic/irreversible shell
  operations (`rm -rf`, force push, `git reset --hard`, `git clean -f*`, `sudo`,
  `mkfs`, `dd of=/dev/*`, …) are hard-denied regardless of allowlist or approval,
  even under auto-accept/`--yes`. A deliberate per-command allowlist opt-in lifts
  it; a broad `*` does not.

### Changed

- **Context compaction overhaul** — fast-model default, background + silent
  auto-compaction, real-token trigger with reactive overflow→compact→retry, a
  `ctx NN%` status indicator, and a deterministic fidelity guard. Plus **in-turn
  compaction** so a single long agentic turn never overflows the context window.

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
