# Excalibur Core

**Local-first AI-assisted and agentic software development, from your terminal.**

Excalibur Core is an open-source developer toolkit that brings structured, safe, configurable AI workflows to any repository. It is CLI-first, works entirely on your machine, produces auditable artifacts for everything it does, and never modifies a file without your approval.

```bash
excalibur init
excalibur run "Fix duplicated escrow release on webhook retry"
excalibur run "Implement contract renewal reminders" --careful
excalibur discovery "Should we add multi-party contract approval?"
```

> **Status — M1 (mock loop).** This milestone ships the complete local experience — init, workflows, methodologies, patches, runs, Discovery, reports, extensions, instruction discovery — with a **deterministic mock model provider only**. No real model calls, no real file modification and no real command execution happen inside runs (commands are simulated and clearly marked `simulated: true`). Real providers and agents arrive in M2/M3. Every output of the mock provider is labeled as such.

## Why Excalibur

- **Autonomy is a dial, not a switch.** Five explicit autonomy levels, from "review only" to "full agentic workflow", configurable per command, path and task type.
- **Workflows, not vibes.** Every agentic task runs a declared workflow with phases, approvals and artifacts — 14 built-in workflows and 14 methodologies out of the box.
- **Safe by default.** The `standard-safe` preset blocks secrets and sensitive paths, asks before any mutation, never pushes, and redacts secrets from prompts and logs.
- **Local and auditable.** Runs, patches, interactions, discovery sessions and reports live under `.excalibur/` in your repository as plain files (JSON, JSONL, Markdown, YAML).
- **Starts with what you already have.** Instruction & Skill Discovery (ISD) finds your existing `CLAUDE.md`, `AGENTS.md`, Cursor rules, Copilot instructions and `SKILL.md` files and uses them safely — never rewriting or copying them without consent.
- **Extensible from day one.** YAML/Markdown defines how your team works; the TypeScript SDK connects Excalibur to the outside world.

## Install / build from source

Requirements: Node ≥ 22, pnpm 9.

```bash
git clone https://github.com/ExcaliburOSS/excalibur-core.git
cd excalibur-core
pnpm install
pnpm -r build

# run the CLI
node apps/cli/dist/main.js --help
# or link it
cd apps/cli && npm link && excalibur --help
```

## Quickstart

Point Excalibur at a repository once:

```bash
cd your-repo
excalibur init                  # detects your stack, commands and existing AI instructions
```

Then just describe the work and let an agent build it. Excalibur infers the right workflow and safety rules, creates an isolated branch/worktree, makes the change, runs your tests, and hands back a diff and summary to review — nothing is pushed and nothing merges without you:

```bash
excalibur run "Add idempotency to the escrow webhook handler"
```

Watch it work, then inspect everything as plain local files:

```bash
excalibur status                # the run, its phases and cost
excalibur logs                  # the full event log of the latest run
```

Match the rigor to the task — Excalibur infers it, or you can steer:

```bash
excalibur run "Migrate billing to the new ledger" --careful       # plan → your approval → implement → tests → review
excalibur run "Explore options for contract versioning" --explore # alternative approaches, compared side by side
```

Not sure it should be built yet? **Start before the code:**

```bash
excalibur discovery "Add AI contract renewal reminders"           # clarifies scope; can recommend *not* building
```

Prefer to keep your hands on the keyboard? The same engine does lighter, non-agentic help too — `excalibur ask` answers questions about the repo, `excalibur patch` proposes a diff for you to apply, `excalibur review --diff` reviews your uncommitted changes.

> **M1:** every command runs on a deterministic mock model, and the agent's file edits, test runs and commands are simulated (and labelled as such). What's real today is the full workflow, the phase/event stream, the local artifacts and the safety rules — real model and agent execution land in M2/M3.

## Autonomy levels

| Level | Name | What the AI may do | Typical command |
|---|---|---|---|
| 0 | Review | Read and review; never changes code | `excalibur review --diff` |
| 1 | Assist | Explain, answer, suggest | `excalibur ask "..."` |
| 2 | Propose Patch | Generate a diff; never applies it automatically | `excalibur patch "..."` |
| 3 | Implement in Branch | Work in an isolated branch/worktree | `excalibur run "..."` |
| 4 | Full Agentic Workflow | Multi-phase workflow with tools, tests, outputs | `excalibur run "..." --careful` |

Levels can be set per command, per path (`autonomy.paths`), per task type and per workflow. See [docs/autonomy-levels.md](docs/autonomy-levels.md).

## The `.excalibur/` directory

`excalibur init` generates a **minimal**, human-readable, Git-versionable configuration — and everything works with defaults even without it:

```text
.excalibur/
  config.yaml          # project, commands, safety preset, defaults
  instructions/        # project instructions prepended to every prompt
  extensions.yaml      # extension enablement
  models/providers.yaml# model providers (env var NAMES only, never keys)
  workflows/           # optional: override/add workflows (YAML)
  methodologies/       # optional: override/add methodologies (YAML)
  policies/            # optional: policy presets
  runs/                # local run artifacts (run.json, events.jsonl, diff.patch, ...)
  patches/             # patch proposals
  interactions/        # ask/explain/review artifacts
  discovery/           # discovery sessions
  reports/             # daily / weekly-plan markdown reports
```

`excalibur init --team` adds shared team standards; `excalibur init --full` exports every built-in catalog for inspection. See [docs/configuration.md](docs/configuration.md).

## Extensions

Excalibur is an extensible runtime with one core principle:

> **YAML/Markdown defines how the team works. SDK code connects Excalibur to the outside world.**

- **Declarative extensions** (no code): methodologies, workflows, question packs, prompt/artifact templates, policy presets, model routing, report templates, roles, command mappings. Safe, portable, reviewable in Git.
- **Programmatic extensions** (TypeScript SDK): work item providers, communication providers, model providers, agent adapters, tools, context sources, exporters, policy evaluators. Powerful, permissioned.

```bash
excalibur extensions list
excalibur extensions create methodology spike-driven
excalibur extensions validate
excalibur methodologies list        # your methodology appears next to the built-ins
```

The built-in catalogs ship as extension packs through the same mechanism — project files override built-ins with zero special-casing. See [docs/extensions/overview.md](docs/extensions/overview.md) and the examples in [`examples/extensions/`](examples/extensions/).

## Relationship to Excalibur Enterprise

Excalibur Core is the open-source, local-first foundation. **Excalibur Enterprise** builds on the exact same schemas, event format, workflow definitions and artifacts, and adds the organizational control plane: web workbench, SSO/RBAC, team management, audit logs, cost and model governance, GitHub/GitLab Apps, hybrid runners and compliance.

Everything stays local unless you explicitly connect: `excalibur login` / `excalibur sync` are optional, transparent and experimental. See [docs/enterprise-sync.md](docs/enterprise-sync.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration (`.excalibur/`)](docs/configuration.md)
- [Autonomy levels](docs/autonomy-levels.md)
- [Workflows](docs/workflows.md)
- [Methodologies](docs/methodologies.md)
- [Model providers](docs/providers.md)
- [Agents](docs/agents.md)
- [Security defaults](docs/security.md)
- [Enterprise sync](docs/enterprise-sync.md)
- [CMUX integration](docs/cmux.md)
- [Extensions](docs/extensions/overview.md)

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r lint
```

The repo is a pnpm/TypeScript monorepo: `packages/` holds the engine (`core`, `workflow-schema`, `model-gateway`, `agent-runtime`, `context-engine`, `extension-runtime`, `extension-sdk`, `built-in-extensions`, `declarative-schemas`, `work-items`, `enterprise-sync`, `shared`) and `apps/cli` the `excalibur` binary.

## License

[Apache-2.0](LICENSE).
