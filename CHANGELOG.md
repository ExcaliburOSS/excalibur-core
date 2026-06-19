# Changelog

All notable changes to Excalibur Core are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- The full milestone roadmap (M1–M8) lives in [docs/ROADMAP.md](docs/ROADMAP.md).
- Not yet published to npm; install from source (see [README](README.md)).
