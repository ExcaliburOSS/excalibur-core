# Getting started

Excalibur Core works in minutes, without choosing methodologies, workflows or policies first. This guide walks through the first session in a real repository.

> **M1 note.** This milestone uses a built-in deterministic **mock** model provider — no API keys needed, no real model calls made, and runs never modify your files (everything mutating is simulated and labeled). The full command surface is real; the model behind it arrives in M2.

## 1. Build the CLI

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

`init` detects your stack (languages, frameworks, package manager), your test/lint/typecheck/build commands, and any AI instruction files you already maintain (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, Copilot instructions, `SKILL.md` files, README/docs/ADRs). It then asks **one** optional question — which model provider to use (skippable; the mock is the M1 default) — and writes a minimal `.excalibur/`:

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
excalibur apply patch_20260613_102501     # mark applied (simulated in M1)
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

Execution styles: `--fast`, `--careful` (Level 4, stronger approvals), `--structured`, `--explore` (engineering alternatives). Every run streams its events to the terminal and stores everything under `.excalibur/runs/<run-id>/`.

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

## 6. Daily rhythm

```bash
excalibur daily        # today's runs, patches and commits as markdown
excalibur weekly-plan  # last week summarized + a lightweight plan
excalibur doctor       # PASS/WARN/FAIL diagnosis of your setup
```

## Where to go next

- [Configuration](configuration.md) — everything in `.excalibur/config.yaml`
- [Autonomy levels](autonomy-levels.md) — the 0–4 dial in depth
- [Workflows](workflows.md) and [Methodologies](methodologies.md) — the built-in catalogs
- [Model providers](providers.md) — configuring real providers (M2)
- [Security](security.md) — what `standard-safe` guarantees
- [Extensions overview](extensions/overview.md) — extending Excalibur
