<div align="center">

# ⚔ Excalibur

### The AI coding agent for product engineers.

**Most agents write code. Excalibur knows the whole product cycle — discover, build, verify, ship.**

On any model, in any terminal. Local-first, safe by default, no account.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-2368D0.svg)](LICENSE)
&nbsp;[![npm](https://img.shields.io/npm/v/@excalibur-oss/excalibur?color=2368D0&label=npm)](https://www.npmjs.com/package/@excalibur-oss/excalibur)
&nbsp;![Local-first · no account](https://img.shields.io/badge/local--first-no%20account-2368D0)

</div>

```bash
npm install -g @excalibur-oss/excalibur   # one binary, zero runtime deps
cd your-repo && excalibur                  # detects your stack, connects a model — start building
```

> Two commands, about five minutes. Bring your own model key — nothing leaves your machine unless you say so.

---

## What sets Excalibur apart

Five capabilities built into the engine — free and open-source.

### ⏳ Time Travel

**Every run is an immutable, append-only event log — so you can scrub it like a video and branch from any step.**
This isn't a "rewind button" bolted on: the deterministic event stream _is_ the run. One source of truth renders the live TUI, the replay, the web dashboard and the audit trail — byte-identical. Nobody else is built this way.

- **Fork from cache** — branch a new run from any checkpoint; the good prefix replays for free, only what changed re-runs
- **Live rewind** mid-session (`Esc` `Esc`)
- Live = replay = dashboard = audit — one immutable stream, every angle

### 🧭 Discovery

**Decide what to build — or whether to build at all — before a line of code.**
Discovery weighs scope, evidence and risk, then recommends _build_, _validate_, or _don't build yet_. The one gate no other AI tool has.

- Product judgment, not just code generation
- Turns a vague idea into a scoped work item
- Kills bad work before it costs you

### 🖥️ Command Center

**Your repo on a board — runs, cost and a live swarm chronogram, in one local process.**
`excalibur serve` ships a token-gated, **task-first** web dashboard embedded in the CLI. No SaaS, no account — it's that same event log, rendered for the browser. Terminal-only tools don't have this.

- Kanban work items → drill into a run's live checklist, patches, PRs and plans
- Cost/token insights + a live wave/DAG **chronogram** you can pause, resume and time-travel
- `--write` to drive runs from the browser; `--share` mints a read-only link for the team

### 🧠 Any model, no lock-in

**Bring your own — OpenAI-compatible (incl. Azure OpenAI), Anthropic, Ollama, and more.**
Excalibur isn't wired to a single vendor. Pick a good + fast pair with one key, switch anytime with `/models`.

- A frontier model for the hard parts, a cheap one for ghost-text — automatically
- Keys live in an env file, never in the repo

### 🔄 The whole product cycle

**Most agents write code. Excalibur owns the bookends too.**

```text
Discover → Plan → Build → Test → Document → Review → Ship → Audit
```

- Decide before you build (Discovery); **prove it after** — an adversarial _verification mesh_ + typed claims (`tests_passed` · `type_safe` · `no_secrets`) gate the finish
- A big task **auto-sizes into a swarm** of agents in isolated worktrees — you never pick the shape
- Tests and serious docs are phases, not afterthoughts; 14 workflows ship in the box, all overridable in YAML

> All five — built into the engine, free and open-source, one `npm install` away.

---

## Not commands. A conversation.

Run `excalibur` with no arguments and you're in the **m-shell**. You don't memorize flags — you describe the work and watch it happen:

```text
› add rate limiting to the public API and cover it with tests

  ◐ Understand   read 6 files · mapped the gateway
  ✎ Implement    edit src/api/limiter.ts   +48 −4
  ✓ Test         pnpm test  →  124 passed
  ──────────────────────────────────────────────
  standard-safe · $0.03 · 18s              ✓ done
```

- **Just describe it.** Excalibur infers the workflow, fans out a swarm when the task splits, and streams the plan, edits, tests and diff in a live rail — which you can **interrupt anytime** (type to steer it, `Esc` to cancel).
- **It chooses the shape.** A multilingual intent router reads each turn and dimensions the work itself — parallel swarm, background job, or cited research — so you never reach for `swarm` / `bg` / `threads` (they're there when you want them).
- **Slash commands when you want them:** `/models`, `/agent`, `/plan`, `/bg`, `/threads`, `/share`.
- **Multilingual** out of the box (English + Spanish).

Prefer one-shot or CI? Every capability is also a subcommand — same engine, no shell:

```bash
excalibur run "…"      excalibur ask "…"        excalibur review --diff
excalibur swarm "…"    excalibur discovery      excalibur verify
```

---

## Safe by default

`standard-safe` is on from the very first command:

- **Approval gates** — nothing is written, pushed or merged without your yes
- **Sandboxed** — no network by default; work isolated in branches, never your tree
- **Secrets never leak** — blocked from sensitive paths, redacted from prompts and logs
- **Inspectable trail** — every action is a plain file you can read

---

## Local & auditable

Everything lives under `.excalibur/` as plain, Git-versionable files — and it all works with defaults even without config:

```text
.excalibur/
  config.yaml            # project, commands, safety, defaults
  models/providers.yaml  # provider env-var NAMES only — never keys
  memory/                # decisions that compound — every run gets sharper
  work-items/            # native kanban (WI-<n>.json)
  runs/ patches/ plans/ discovery/ reports/ shares/
```

`excalibur init` detects your stack, your commands, and your existing AI instructions — `CLAUDE.md`, `AGENTS.md`, Cursor rules, Copilot instructions, `SKILL.md` — and uses them without rewriting them.

---

## Extend it

> **YAML defines how your team works. The TypeScript SDK connects everything else.**

- **Declarative (no code):** workflows, methodologies, question packs, templates, policies, model routing, reports, roles — portable and reviewable in Git.
- **Programmatic (SDK):** work-item / model / comms providers, agent adapters, tools, context sources, exporters, policy evaluators — permissioned and enforceable (`extensions.enforce` hard-blocks one that over-reaches).

```bash
npm install @excalibur-oss/extension-sdk
excalibur extensions create tool my-extension
```

Plus a **VS Code / Cursor / Windsurf** extension that bridges your editor to `excalibur acp` — run tasks, ask about a selection, review, and watch the agent stream into a session view with native approval modals.

---

## Core vs Enterprise

Excalibur Core is the open-source, local-first foundation — everything above, free forever, no account. **Excalibur Enterprise** builds on the exact same schemas, events and artifacts, and adds the org control plane: a web Workbench, SSO / RBAC, work-item sync (Linear · Jira), a policy engine + budgets, a signed Compliance Pack, and hybrid runners. Everything stays local unless you explicitly connect.

---

## Docs

[Getting started](docs/getting-started.md) · [The m-shell](docs/interactive-shell.md) · [Configuration](docs/configuration.md) · [Workflows](docs/workflows.md) · [Model providers](docs/providers.md) · [Security defaults](docs/security.md) · [Dashboard](docs/dashboard.md) · [Extensions](docs/extensions/overview.md) · [Enterprise sync](docs/enterprise-sync.md)

## Development

```bash
# from source — Node ≥ 22, pnpm 9
git clone https://github.com/ExcaliburOSS/excalibur-core.git
cd excalibur-core && pnpm install && pnpm -r build && pnpm -r test
```

A pnpm / TypeScript monorepo: `packages/` holds the engine (`core`, `model-gateway`, `agent-runtime`, `context-engine`, `tui`, `work-items`, `extension-sdk`, …), `apps/cli` is the `excalibur` binary, `apps/dashboard` the embedded web UI, `apps/vscode` the IDE extension.

## License

[Apache-2.0](LICENSE).
