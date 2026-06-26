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

## Five things only Excalibur does

Built right into the engine — the ones you won't find in any other AI coding tool. All five, free and open-source.

### ⏳ Time Travel

**Scrub any run like a video — and branch a new one from any step.**
Every run is a deterministic event stream, so you can rewind it and fork from any moment.

- **Fork from cache** — the good prefix replays for free; only what changed re-runs
- **Live rewind** mid-session (`Esc` `Esc`)
- The replay _is_ your audit trail

### 🧭 Discovery

**Decide what to build — or whether to build at all — before a line of code.**
Discovery weighs scope, evidence and risk, then recommends _build_, _validate_, or _don't build yet_. The one gate no other AI tool has.

- Product judgment, not just code generation
- Turns a vague idea into a scoped work item
- Kills bad work before it costs you

### 🐝 Self-Sizing Swarm

**Hand over a big task; Excalibur sizes the agent team and explores rival approaches at once.**
You never pick a number.

- One agent per independent subtask, in isolated worktrees, merged on fan-in
- **Explore (best-of-N)** — run rival approaches, compare diffs, tests & cost, keep the winner
- Native to the run engine — no CMUX, no glue

### 🛡️ Adversarial Review

**Before work reaches you, a skeptical agent tries to refute it.**
Every typed claim must check out — a run can't reach "done" on an unverified one.

- Claims: `tests_passed` · `type_safe` · `no_secrets`
- An independent reviewer hunts for holes first
- An adversarial **verification mesh** blocks a change that fails its own claims

### 📦 Isolated Sandbox

**Agents run boxed — no network by default, in dedicated branches, with secrets walled off.**

- No network access unless you grant it
- Work lands in isolated branches, never your working tree
- Secrets blocked & redacted; risky ops need your approval

> _Nothing leaves the box — and nothing changes — without your yes._

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

## The whole product cycle

Chatbots autocomplete. Coding agents build and ship. **Excalibur runs the entire cycle** — and owns the bookends other tools skip:

```text
Discover → Plan → Build → Test → Document → Review → Ship → Audit
```

Tests and serious docs aren't an afterthought — they're **gates**. 14 workflows and methodologies ship in the box (Standard Feature, Safe Refactor, Security First, Migration, Explore Alternatives, Discovery…), all overridable in YAML.

---

## Safe by default

`standard-safe` is on from the very first command:

- **Approval gates** — nothing is written, pushed or merged without your yes
- **Sandboxed** — no network by default; work isolated in branches, never your tree
- **Secrets never leak** — blocked from sensitive paths, redacted from prompts and logs
- **Inspectable trail** — every action is a plain file you can read

---

## Bring your own model

OpenAI-compatible providers (incl. Azure OpenAI), Anthropic, Ollama and more — pick a good + fast pair with a single key, switch anytime with `/models`. Keys live in an env file, never in the repo.

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

## The web dashboard

`excalibur serve` ships a local, token-gated, **task-first** board embedded in the CLI — kanban work items, live run checklists, patches / PRs / plans, cost charts, and a live wave/DAG **chronogram** of a swarm you can pause, resume and time-travel through. `--write` makes it interactive; `--share` mints a read-only link. One process, no extra setup.

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
