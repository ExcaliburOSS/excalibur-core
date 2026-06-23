# Excalibur Core

**Local-first AI-assisted and agentic software development, from your terminal.**

Excalibur Core is an open-source developer toolkit that brings structured, safe,
configurable AI workflows to any repository. It runs as an **interactive shell**
on your machine, executes real agentic work with the models you bring, produces
auditable artifacts for everything it does, and never modifies a file without
your approval.

```bash
npm install -g @excalibur-oss/excalibur   # or: npx @excalibur-oss/excalibur
excalibur                                  # launch the interactive shell
```

## The shell is the product

Run `excalibur` with no arguments and you drop into the **Excalibur shell** — the
primary way to use it. You don't memorize flags; you talk to it:

- **Just describe the work.** Type a task in plain language and Excalibur infers
  the right workflow, autonomy and safety rules, then streams the agent's plan,
  tool calls, edits, tests and diff in a live rail you can watch and interrupt
  (`Esc` cancels the running step).
- **Slash commands when you want them.** `/models` to pick a provider/model,
  `/agent` to switch persona, `/bg` and `/threads` to run and juggle work in the
  background, `/plan`, `/share`, `/help` — discoverable, single-key where it
  counts.
- **Ghost-text suggestions** and context-aware placeholders guide the next move;
  it reads your memory, last activity and active plan and _offers_ — it never
  makes you type arcane incantations.
- **Conversational intent.** Ask a question, request a patch, kick off a full
  agentic run, or start a Discovery — the shell routes intent to the right mode
  (multilingual: English + Spanish out of the box).

Prefer one-shot/CI use? Every capability is also a direct subcommand
(`excalibur run "…"`, `excalibur ask "…"`, `excalibur review --diff`, …) — same
engine, no shell required.

## Why Excalibur

- **Autonomy is a dial, not a switch.** Five explicit autonomy levels, from
  "review only" to "full agentic workflow", configurable per command, path and
  task type.
- **Workflows, not vibes.** Every agentic task runs a declared workflow with
  phases, approvals and artifacts — built-in workflows and methodologies out of
  the box, all overridable in YAML.
- **Safe by default.** The `standard-safe` preset blocks secrets and sensitive
  paths, asks before any mutation, never pushes, and redacts secrets from prompts
  and logs. An adversarial Verification Mesh can block a run that fails its own
  claims.
- **Local and auditable.** Runs, patches, interactions, discovery sessions and
  reports live under `.excalibur/` as plain files (JSON, JSONL, Markdown, YAML).
- **Connected when you want it.** Native, governed `web_fetch` / `web_search`
  (free, no key by default), an opt-in local browser, cited research, and
  first-class MCP servers (OAuth + a signed registry) — all behind an audited
  network policy.
- **Starts with what you already have.** Instruction & Skill Discovery finds your
  existing `CLAUDE.md`, `AGENTS.md`, Cursor rules, Copilot instructions and
  `SKILL.md` files and uses them safely — never rewriting them without consent.
- **Bring your own model.** OpenAI-compatible providers (incl. Azure OpenAI),
  Anthropic, Ollama and more; pick good+fast pairs with one key. Keys live in an
  env file, never in the repo.

## Install

```bash
# Published binary (zero runtime deps):
npm install -g @excalibur-oss/excalibur
excalibur

# …or run without installing:
npx @excalibur-oss/excalibur
```

From source (Node ≥ 22, pnpm 9):

```bash
git clone https://github.com/ExcaliburOSS/excalibur-core.git
cd excalibur-core && pnpm install && pnpm -r build
node apps/cli/dist/main.js            # or: cd apps/cli && npm link && excalibur
```

## Point it at a repo

```bash
cd your-repo
excalibur init       # detects your stack, commands and existing AI instructions
excalibur            # then just start working in the shell
```

In the shell (or as one-shot subcommands):

- **Build it:** describe a change → plan → isolated branch/worktree → edits →
  your tests → a diff + summary to review. Nothing is pushed or merged without you.
- **Steer the rigor:** `--careful` (plan → approval → implement → test → review)
  or `--explore` (compare alternative approaches).
- **Start before the code:** Discovery clarifies scope and can recommend _not_
  building yet, scoring readiness for an agent.
- **Lighter help:** ask questions about the repo, propose a diff to apply, or
  review your uncommitted changes — non-agentic, same engine.

## Autonomy levels

| Level | Name                  | What the AI may do                              | Example                         |
| ----- | --------------------- | ----------------------------------------------- | ------------------------------- |
| 0     | Review                | Read and review; never changes code             | `excalibur review --diff`       |
| 1     | Assist                | Explain, answer, suggest                        | `excalibur ask "..."`           |
| 2     | Propose Patch         | Generate a diff; never applies it automatically | `excalibur patch "..."`         |
| 3     | Implement in Branch   | Work in an isolated branch/worktree             | `excalibur run "..."`           |
| 4     | Full Agentic Workflow | Multi-phase workflow with tools, tests, outputs | `excalibur run "..." --careful` |

Levels can be set per command, per path (`autonomy.paths`), per task type and per
workflow. See [docs/autonomy-levels.md](docs/autonomy-levels.md).

## The web dashboard

`excalibur serve` exposes a local, token-gated **task-first dashboard**: a kanban
board of work items where you drill into a work item to see its runs, the active
run's live checklist, patches, PRs, plans and discovery — plus an insights view
(cost/token charts) and a runs explorer. `--write` makes it interactive
(drag-to-move lanes, start/cancel/approve runs from the browser); `--share` mints
a read-only token. It ships embedded in the CLI — one process, no extra setup.
See [docs/dashboard.md](docs/dashboard.md).

## The `.excalibur/` directory

`excalibur init` generates a **minimal**, human-readable, Git-versionable
configuration — and everything works with defaults even without it:

```text
.excalibur/
  config.yaml           # project, commands, safety preset, defaults
  instructions/         # project instructions prepended to every prompt
  extensions.yaml       # extension enablement
  models/providers.yaml # model providers (env var NAMES only, never keys)
  workflows/  methodologies/  policies/   # optional overrides/additions
  work-items/           # the native kanban work items (WI-<n>.json)
  runs/  patches/  interactions/  discovery/  plans/  reports/  shares/
```

`excalibur init --team` adds shared team standards; `--full` exports every
built-in catalog. See [docs/configuration.md](docs/configuration.md).

## Extensions

> **YAML/Markdown defines how the team works. SDK code connects Excalibur to the
> outside world.**

- **Declarative extensions** (no code): methodologies, workflows, question packs,
  prompt/artifact templates, policy presets, model routing, reports, roles,
  command mappings — safe, portable, reviewable in Git.
- **Programmatic extensions** (TypeScript SDK on npm): work-item providers,
  communication providers, model providers, agent adapters, tools, context
  sources, exporters, policy evaluators — powerful, permissioned, and enforceable
  (`extensions.enforce` hard-blocks an extension that over-reaches).

```bash
npm install @excalibur-oss/extension-sdk
excalibur extensions create tool my-extension
```

The built-in catalogs ship as extension packs through the same mechanism. See
[docs/extensions/overview.md](docs/extensions/overview.md) and the
[authoring guide](docs/extensions/authoring.md).

## IDE extension

A VS Code / Cursor / Windsurf extension (`apps/vscode`) bridges the editor to
`excalibur acp` over the Agent Client Protocol: run tasks, ask about a selection,
review, and watch the agent stream into a webview session view — with native
approval modals.

## Relationship to Excalibur Enterprise

Excalibur Core is the open-source, local-first foundation. **Excalibur
Enterprise** builds on the exact same schemas, event format, workflows and
artifacts, and adds the organizational control plane: web workbench, SSO/RBAC,
team management, audit logs, cost/model governance, GitHub/GitLab Apps, hybrid
runners and compliance. Everything stays local unless you explicitly connect
(`excalibur login` / `excalibur sync` are optional + transparent). See
[docs/enterprise-sync.md](docs/enterprise-sync.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration (`.excalibur/`)](docs/configuration.md)
- [Autonomy levels](docs/autonomy-levels.md)
- [Work items & kanban](docs/work-items.md)
- [Web dashboard](docs/dashboard.md)
- [Workflows](docs/workflows.md) · [Methodologies](docs/methodologies.md)
- [Model providers](docs/providers.md) · [Agents](docs/agents.md)
- [Security defaults](docs/security.md)
- [Extensions](docs/extensions/overview.md) · [Authoring guide](docs/extensions/authoring.md)
- [Enterprise sync](docs/enterprise-sync.md) · [CMUX integration](docs/cmux.md)

## Development

```bash
pnpm install && pnpm -r build && pnpm -r test && pnpm lint
```

A pnpm/TypeScript monorepo: `packages/` holds the engine (`core`,
`workflow-schema`, `model-gateway`, `agent-runtime`, `context-engine`,
`extension-runtime`, `extension-sdk`, `built-in-extensions`,
`declarative-schemas`, `work-items`, `enterprise-sync`, `tui`, `shared`),
`apps/cli` the `excalibur` binary, `apps/dashboard` the embedded web UI, and
`apps/vscode` the IDE extension.

## License

[Apache-2.0](LICENSE).
