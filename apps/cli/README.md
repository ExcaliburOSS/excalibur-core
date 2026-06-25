# Excalibur CLI

**Local-first, AI-assisted and agentic software development from your terminal.**

Excalibur Core is an open-source developer toolkit for AI-assisted and agentic
coding. It runs entirely on your machine, keeps every artifact in a portable
`.excalibur/` directory, and never sends your code anywhere you didn't configure.

> Part of [Excalibur Core](https://github.com/ExcaliburOSS/excalibur-core) (Apache-2.0).

## Install

```bash
npm install -g @excalibur-oss/excalibur
```

A single, self-contained binary — no extra setup, no peer dependencies to
resolve.

> Requires Node.js 22 or newer.

## Quickstart — two commands

```bash
npm install -g @excalibur-oss/excalibur
cd your-project && excalibur
```

That's the whole setup. On the **first run in a repo**, Excalibur sets itself up
for you — detects your stack, helps you connect a model (your **API key** _or_ a
**subscription**), writes a minimal `.excalibur/` — then drops you into the
**interactive shell**. You never have to discover `init` or `models setup`.

In the shell, just say what you want in plain language; Excalibur picks the right
action and autonomy level for you:

```text
▸ where is escrow release implemented?
▸ add an idempotency guard to the webhook handler
▸ /rewind                                    # scrub a run, fork from any step
▸ /swarm refactor the billing module + tests # parallel agents in worktrees
```

Prefer one-shot subcommands? They all work too:

```bash
excalibur ask "Where is escrow release implemented?"
excalibur run "Add an idempotency guard to the webhook handler" --fast
excalibur status && excalibur logs
```

> `excalibur init` is **optional** — only for explicit `--team` / `--full`
> scaffolding or CI. You never need it to get value.

## What you can do

| Command                                    | What it does                                                          |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `excalibur`                                | The interactive shell — describe what you want; onboards on first run |
| `excalibur run "…"`                        | Run an agentic workflow phase by phase (autonomy L3/L4)               |
| `excalibur swarm "…"`                      | Fan out independent subtasks as parallel agents in git worktrees      |
| `excalibur explore "…"`                    | Best-of-N — run N candidate approaches in parallel, keep the winner   |
| `excalibur orchestrate` · `orchestration`  | Re-run/resume a parallel run · watch its live wave/DAG chronogram     |
| `excalibur schedule add "…" "…"`           | Autonomous scheduled jobs (every N / daily at)                        |
| `excalibur ask "…"` / `explain`            | Ask questions about the repo (L1)                                     |
| `excalibur review [--diff]`                | Review working changes (L0)                                           |
| `excalibur patch "…"` → `apply` / `branch` | Propose a diff, then apply it (L2)                                    |
| `excalibur rewind`                         | Time machine — step a run, fork or undo from any step                 |
| `excalibur verify`                         | Adversarial Verification Mesh over a run's changes                    |
| `excalibur serve`                          | Read-only web dashboard (runs / events / insights) over local HTTP    |
| `excalibur insights`                       | Cross-run cost / token / outcome lens                                 |
| `excalibur discovery "<idea>"`             | Decide _whether_ to build — deterministic scoring                     |
| `excalibur work-items`                     | GitHub Issues as agent-native work items (via the `gh` CLI)           |
| `excalibur mcp` · `theme` · `doctor`       | Inspect MCP servers · switch TUI theme · diagnose your setup          |

Run `excalibur <command> --help` for the full set of flags. Autonomy levels
(0–4), workflows, model routing and tool permissions all live in
`.excalibur/config.yaml`.

## Models — bring your own

Excalibur is model-agnostic and **BYOK** (bring your own key): your API keys are
read from environment variables and never written to `.excalibur/`. First-run
onboarding connects one for you; to switch or add providers later:

```bash
excalibur models setup     # API key or subscription · auto-pairs a fast model
excalibur models list
```

One key configures a curated **good + fast** model pair (the fast model powers
ghost-text suggestions and context compaction). A deterministic offline **mock**
provider is the zero-config default until you connect a real model.

## Links

- **Repository:** https://github.com/ExcaliburOSS/excalibur-core
- **Issues:** https://github.com/ExcaliburOSS/excalibur-core/issues
- **License:** Apache-2.0
