# Excalibur CLI

**Local-first, AI-assisted and agentic software development from your terminal.**

Excalibur Core is an open-source developer toolkit for AI-assisted and agentic
coding. It runs entirely on your machine, keeps every artifact in a portable
`.excalibur/` directory, and never sends your code anywhere you didn't configure.

> Part of [Excalibur Core](https://github.com/ExcaliburOSS/excalibur-core) (Apache-2.0).

## Install

```bash
npm install -g @excalibur/cli
```

That installs a single, self-contained binary — no extra setup, no peer
dependencies to resolve. Verify it:

```bash
excalibur --version
excalibur --help
```

> Requires Node.js 22 or newer.

## Quickstart

```bash
# 1. Set up Excalibur in your repo (detects your stack, writes .excalibur/)
cd your-project
excalibur init

# 2. Ask a question about the codebase
excalibur ask "Where is escrow release implemented?"

# 3. Run an agentic task (autonomy is a visible, adjustable dial)
excalibur run "Add an idempotency guard to the webhook handler" --fast

# 4. Inspect what happened — every run is a portable, replayable artifact
excalibur status
excalibur logs
```

`init` is intentionally minimal: it writes only `config.yaml` and
`instructions/general.md`, bootstraps a root `AGENTS.md` if you don't have one,
and applies the `standard-safe` security preset (sensitive paths blocked, pushes
and network disabled by default). Nothing else is required before you get value.

## What you can do

| Command | What it does |
| --- | --- |
| `excalibur init [--team\|--full]` | Detect the stack and scaffold `.excalibur/` |
| `excalibur ask "…"` / `explain` | Ask questions about the repo (autonomy L1) |
| `excalibur review [--diff]` | Review working changes (autonomy L0) |
| `excalibur patch "…"` + `apply\|branch\|reject` | Propose and apply a diff (L2) |
| `excalibur run "…"` | Run an agentic workflow phase by phase (L3) |
| `excalibur discovery "<idea>"` | Decide *whether* to build — deterministic scoring |
| `excalibur daily` / `weekly-plan` | Generate local activity reports |
| `excalibur workflows list\|explain` | Inspect the 14 built-in workflows |
| `excalibur instructions scan\|list` | Detect existing CLAUDE.md / AGENTS.md / skills |
| `excalibur extensions …` | Author and load declarative/programmatic extensions |
| `excalibur doctor` | Diagnose your setup |

Run `excalibur <command> --help` for the full set of flags. Autonomy levels
(0–4), workflows, model routing and tool permissions are all configurable in
`.excalibur/config.yaml`.

## Models

Excalibur is model-agnostic. Configure a provider interactively — your API keys
are read from environment variables and never written to `.excalibur/`:

```bash
excalibur models setup     # openai-compatible · anthropic · openrouter · ollama · mock
excalibur models list
```

A deterministic built-in **mock** provider is the default, so every command
works end to end before you connect a real model.

## Links

- **Repository:** https://github.com/ExcaliburOSS/excalibur-core
- **Issues:** https://github.com/ExcaliburOSS/excalibur-core/issues
- **License:** Apache-2.0
