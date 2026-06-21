# Getting started

Excalibur Core works in minutes, without choosing methodologies, workflows or policies first. This guide walks through the first session in a real repository.

> **Models & safety.** Excalibur drives **real models** out of the box once you point it at one — `anthropic`, `openai-compatible` (incl. vLLM, OpenRouter and custom OpenAI-style endpoints) and `ollama`, with streaming, real token/cost accounting and secret redaction (see [providers.md](providers.md)). With no provider configured it falls back to a built-in deterministic **mock** so you can try every command offline with no API key — its output is always prefixed `> Mock provider`, so it's never mistaken for a real answer. Real runs **do** edit files and run commands — but never without your approval and the Permission Engine's safety floor (see [security.md](security.md)).

## 1. Build the CLI

The easiest way is npm:

```bash
npm install -g @excalibur-oss/excalibur   # or: npx @excalibur-oss/excalibur
```

Or from source:

```bash
git clone https://github.com/ExcaliburOSS/excalibur-core.git
cd excalibur-core
pnpm install && pnpm -r build
cd apps/cli && npm link     # makes `excalibur` available on PATH
```

## 2. Initialize your repository

```bash
cd your-repo
excalibur init
```

`init` detects your stack (languages, frameworks, package manager), your test/lint/typecheck/build commands, and any AI instruction files you already maintain (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, Copilot instructions, `SKILL.md` files, README/docs/ADRs). It then offers to connect a model provider (skippable — the mock is the zero-config fallback) and writes a minimal `.excalibur/`:

```text
.excalibur/config.yaml
.excalibur/instructions/general.md
.excalibur/extensions.yaml
.excalibur/models/providers.yaml   # only when provider setup completed
```

Nothing is ever overwritten silently. Re-running `init` enters update mode and shows what would change; `--force` overwrites after confirmation. `--team` and `--full` generate progressively more shared structure — start minimal.

## 3. Ask, review, patch

```bash
excalibur ask "Where is escrow release implemented?"
excalibur explain src/escrow/escrow.service.ts
excalibur review --diff
```

These are Level 0–1 commands: they **never change code**. Each one writes an artifact set under `.excalibur/interactions/` (input, the effective instructions used, output, metadata).

```bash
excalibur patch "Fix duplicated escrow release on webhook retry"
```

`patch` (Level 2) proposes a unified diff and stores it under `.excalibur/patches/<patch-id>/`. It never applies anything automatically — you decide:

```bash
excalibur apply patch_20260613_102501     # apply the patch to your working tree
excalibur branch patch_20260613_102501    # create a real git branch excalibur/<id>
excalibur reject patch_20260613_102501
```

## 4. Run an agentic workflow

```bash
excalibur run "Fix webhook retry bug"
```

Excalibur classifies the task (small bugfix → `fast-fix`; feature → `standard-feature`; sensitive/migration/security → careful workflows; ambiguous → it suggests Discovery first) and shows its choice before doing anything:

```text
Using: Fast Fix (fast-fix)
Autonomy: Level 3 — Implement in Branch
Safety: standard-safe — No files will be modified without approval.
Plan:
  1. Analyze [assistant_interaction]
  2. Patch [patch_generation]
  ...
[Enter] continue  [m] change mode  [c] cancel
```

The run drives the real native agent loop — reading, searching, writing files and running real commands/tests through `read_file`/`search_code`/`write_file`/`apply_patch`/`run_command`/`run_tests` (and more). Every tool is path-confined to your repo and gated by the Permission Engine; mutating tools default to asking first. Execution styles: `--fast`, `--careful` (Level 4, stronger approvals), `--structured`, `--explore` (engineering alternatives). Every run streams its events to the terminal and stores everything under `.excalibur/runs/<run-id>/`.

```bash
excalibur status     # all local runs
excalibur logs       # event log of the latest run
excalibur pr-summary # a PR description generated from the latest run
```

## 5. Discovery: decide before you build

```bash
excalibur discovery "Add AI contract renewal reminders"
```

Discovery asks 4–8 questions (skippable), scores the answers with deterministic rules, prints a readiness card (problem clarity, evidence, scope, risk, agent readiness) and recommends a next step — which can be **do not build**. Sessions live under `.excalibur/discovery/` and are listed with `excalibur status --discovery`.

## 6. What else you can do

Beyond the core loop, Excalibur ships a broad surface — all real, most enabled by default:

- **Web, search & research.** `web_fetch`, `web_search` (free SearXNG→DuckDuckGo, optional BYOK Exa/Tavily/Brave) and a native **cited research pipeline** (search → fetch → verify → cite). A governed network layer with an always-on SSRF floor (loopback, private ranges and cloud metadata are blocked) keeps it safe.
- **MCP.** First-class MCP client (stdio + Streamable-HTTP), with read-only-role gating, per-server egress sandbox, injection scanning, OAuth/DCR and an Ed25519-signed registry.
- **Swarm.** `excalibur swarm` (or `/swarm` in the shell) fans a task out over isolated git worktrees and grades the results (`--grade`).
- **The interactive M-Shell.** Just run `excalibur` for a full TUI: live event lanes, background/fleet sessions (`/bg`, Tab-cycle threads via `/threads`), and inline approvals.
- **Plan mode & the time machine.** Plan-first execution, plus rewind / fork-from-cache to revisit earlier states.
- **Headless & dashboard.** `run --output-format json/stream-json` and `ask --json-schema` for scripting; `excalibur serve` for a local web dashboard.

A per-session Docker sandbox, LSP per-edit diagnostics fed into the loop, a hard budget cap (`--budget`), the Claim Ledger / Verification Mesh, knowledge-compounding memory (`.excalibur/memory/`) and en+es i18n with auto-detection round out the toolkit. Corporate setups are honored too: `HTTP(S)_PROXY` / `NO_PROXY` / `NODE_EXTRA_CA_CERTS` apply across all egress.

## 7. Daily rhythm

```bash
excalibur daily        # today's runs, patches and commits as markdown
excalibur weekly-plan  # last week summarized + a lightweight plan
excalibur doctor       # PASS/WARN/FAIL diagnosis of your setup (incl. network plan)
```

## Where to go next

- [Configuration](configuration.md) — everything in `.excalibur/config.yaml`
- [Autonomy levels](autonomy-levels.md) — the 0–4 dial in depth
- [Workflows](workflows.md) and [Methodologies](methodologies.md) — the built-in catalogs
- [Model providers](providers.md) — configuring real providers
- [Security](security.md) — what `standard-safe` guarantees
- [Extensions overview](extensions/overview.md) — extending Excalibur
  </content>
  </invoke>
