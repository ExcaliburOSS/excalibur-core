# Agents

The **Agent Runtime** executes the working phases of a workflow through pluggable _agent adapters_.

```ts
interface AgentAdapter {
  id: string;
  name: string;
  capabilities: string[];
  detect(): Promise<boolean>;
  run(input: AgentRunInput): AsyncIterable<ExcaliburEvent>;
  stop?(sessionId: string): Promise<void>;
}
```

Adapters emit the canonical Excalibur event stream (`tool_call`, `file_read`, `file_write`, `command_started`, `test_result`, `patch_generated`, `diagnostics`, …), which the engine forwards to your terminal and to `events.jsonl`.

## Built-in adapters

### `native`

The default adapter, built on the Model Gateway and its native tools:

`read_file · write_file · edit · list_files · search_code · run_command · run_tests · git_diff · apply_patch · create_branch · update_tasks · web_fetch · web_search · web_extract · web_crawl · research · lsp · question · skill`

(`edit` is a surgical find/replace — far cheaper than rewriting a whole file. `lsp` gives the model on-demand code intelligence — go-to-definition, find-references and hover from the language server, gated read-only. `question` lets the model ask the human a clarifying question mid-run; with no human present, e.g. an autonomous/CI run, it returns a note and the model proceeds on its best judgment. `skill` is progressive disclosure: the system prompt lists available `SKILL.md` skills by name + one line, and the model loads a skill's full instructions on demand only when relevant.)

Every tool call passes through the **Permission Engine**: blocked paths are denied, mutating tools default to _ask_, commands outside the allowlist require confirmation (see [security.md](security.md)).

> **Real execution, gated.** The native adapter drives a real model→tool loop: `write_file` writes, `run_command` and `run_tests` execute, `apply_patch` applies — confined to the working directory, gated by the Permission Engine, and approval-gated (mutating tools default to _ask_). The Model Gateway streams from a real provider (`anthropic`, `openai-compatible` incl. vLLM/OpenRouter/custom, or `ollama`) with real token/cost accounting and secret redaction. The built-in `mock` provider is only the zero-config offline default (and CI test double): with it the loop produces a deterministic offline stream and nothing on disk changes, so you can explore without a key.

The native loop also folds in everything else the runtime offers:

- **Extension-contributed tools** — tools registered by extensions (`ctx.tools.registerTool`) are offered to the model alongside the native tools and execute in the loop, announced as `tool_call`s and gated like any other tool (read-only roles only see tools that opt in via `readOnly`).
- **LSP per-edit diagnostics + on-demand code intelligence** — a run-scoped language-server session reports diagnostics back into the loop after each write (emitted as `diagnostics` events) so the model can fix what it just broke, and powers the read-only `lsp` tool (definition/references/hover). ~28 languages are mapped to their conventional servers (TypeScript/JavaScript, Python, Go, Rust, C/C++, Java, Kotlin, Scala, Ruby, PHP, Lua, shell, C#, Elixir, Haskell, OCaml, Clojure, Swift, Zig, Dart, JSON, YAML, TOML, HTML, CSS, Vue, Svelte, Terraform, Markdown). A server that is not installed never errors the run — the `lsp` tool surfaces the exact install command instead. Configurable via `lsp` in config; enabled by default.
- **MCP tools** — configured [MCP](https://modelcontextprotocol.io) servers (stdio + Streamable-HTTP) are connected per run and their tools exposed to the model. Remote endpoints sit behind the per-server egress sandbox + SSRF floor; a read-only role only sees a server's non-mutating tools; tool output is scanned for prompt injection before it reaches the model.
- **Sandbox** — runs can execute inside a per-session Docker sandbox (network none, no host secrets) when configured.

### `custom-command`

Wraps any CLI coding agent (Claude Code, Aider, Codex CLI, …) as an adapter — `run()` drives it as a real subprocess. Configuration shape:

```yaml
agents:
  default: native
  claude-code:
    type: custom-command
    command: 'claude'
    args: ['--print', '{{prompt}}']
  aider:
    type: custom-command
    command: 'aider'
    args: ['--message', '{{prompt}}']
```

`detect()` checks the binary on PATH; `run()` spawns the configured CLI agent as a subprocess (in the working directory, abortable) and folds its output into the event stream.

## Swarm

Run several agents in parallel and pick the best result. `excalibur swarm` (or `/swarm` in the interactive shell) fans a task out across isolated **git worktrees** — each agent works on its own copy of the tree — then fans the results back in. A model decomposes the task into independent subtasks and an allocator **sizes the swarm automatically** (you don't pick the agent count; `--max-agents` is only an optional ceiling). Add `--grade` to score the candidates with a rubric and surface the winner. See [workflows.md](workflows.md).

**You rarely invoke this yourself.** In the interactive shell the intent router decides when work is parallelizable and Excalibur **auto-orchestrates** it: under autonomy a build is decomposed and, when it has ≥2 independent workstreams, executed as an auto-sized swarm (merged + applied) with no command and no prompt — otherwise as a single focused run. The `swarm`/`bg`/`threads` commands remain as explicit escape hatches.

For the full picture — verified fan-in, best-of-N (`explore`), authored DAG specs, the live chronogram, pause/resume, and the scheduler — see **[orchestration.md](orchestration.md)** and **[scheduling.md](scheduling.md)**.

## Agent roles

Workflow phases declare roles, which drive prompts and model routing: `planner`, `architect`, `implementer`, `reviewer`, `tester`, `security`, `release`, plus the Discovery roles (`product_strategist`, `customer_researcher`, `discovery_reviewer`, `ux_reviewer`, `growth_reviewer`, `scope_guardian`).

```yaml
models:
  byRole:
    planner: qwen
    implementer: minimax
    reviewer: qwen
```

## Custom agents (personas)

A **custom agent** is a self-contained persona you define in a single Markdown
file under `.excalibur/agents/<name>.md` — no code, Git-versionable. YAML
frontmatter sets the knobs and the body is the system persona:

```markdown
---
role: security
model: kimi # a provider key from providers.yaml (optional)
provider: kimi # alias for model routing (optional)
temperature: 0.1
tools: [read_file, search_code, lsp] # allowlist — NARROWS the role's tool floor
permissions:
  deniedCommands: ['git push', 'rm *'] # deny wins over allow
---

You are a meticulous security reviewer. Prefer the smallest safe change,
never weaken authn/z, and always explain the threat you are mitigating.
```

Manage and run them:

```bash
excalibur agents init reviewer     # scaffold .excalibur/agents/reviewer.md
excalibur agents list              # all discovered personas
excalibur agents show reviewer     # resolved config + persona body
excalibur run "harden the webhook" --agent reviewer
```

In the interactive shell, `/agent` lists the personas and switches the active
one for subsequent turns. The `tools` allowlist can only **narrow** what the
agent's `role` already permits (it never grants more), and
`permissions.deniedCommands` are subtracted last — deny always wins — so a
persona is a safe, shareable way to specialize behavior without widening
authority. See [autonomy-levels.md](autonomy-levels.md) and
[security.md](security.md).

## Extending

Programmatic extensions can register additional adapters and tools:

```ts
import { defineExtension, type AgentAdapter } from '@excalibur-oss/extension-sdk';

export default defineExtension({
  id: 'my-agent',
  name: 'My Agent',
  version: '0.1.0',
  register(ctx) {
    ctx.agents.registerAdapter(new MyAdapter());
    // ctx.tools.registerTool(myTool); // executed inside the native loop
  },
});
```

Scaffold one with `excalibur extensions create agent-adapter my-agent`. See [extensions/programmatic-extensions.md](extensions/programmatic-extensions.md) and [extensions/creating-a-tool.md](extensions/creating-a-tool.md).
