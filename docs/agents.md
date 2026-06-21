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

`read_file · write_file · edit · list_files · search_code · run_command · run_tests · git_diff · apply_patch · create_branch · update_tasks · web_fetch · web_search · web_extract · web_crawl · research · lsp · question`

(`edit` is a surgical find/replace — far cheaper than rewriting a whole file. `lsp` gives the model on-demand code intelligence — go-to-definition, find-references and hover from the language server, gated read-only. `question` lets the model ask the human a clarifying question mid-run; with no human present, e.g. an autonomous/CI run, it returns a note and the model proceeds on its best judgment.)

Every tool call passes through the **Permission Engine**: blocked paths are denied, mutating tools default to _ask_, commands outside the allowlist require confirmation (see [security.md](security.md)).

> **Real execution, gated.** The native adapter drives a real model→tool loop: `write_file` writes, `run_command` and `run_tests` execute, `apply_patch` applies — confined to the working directory, gated by the Permission Engine, and approval-gated (mutating tools default to _ask_). The Model Gateway streams from a real provider (`anthropic`, `openai-compatible` incl. vLLM/OpenRouter/custom, or `ollama`) with real token/cost accounting and secret redaction. The built-in `mock` provider is only the zero-config offline default (and CI test double): with it the loop produces a deterministic offline stream and nothing on disk changes, so you can explore without a key.

The native loop also folds in everything else the runtime offers:

- **Extension-contributed tools** — tools registered by extensions (`ctx.tools.registerTool`) are offered to the model alongside the native tools and execute in the loop, announced as `tool_call`s and gated like any other tool (read-only roles only see tools that opt in via `readOnly`).
- **LSP per-edit diagnostics** — for editing roles, a run-scoped language-server session reports diagnostics back into the loop after each write (emitted as `diagnostics` events) so the model can fix what it just broke. Configurable via `lsp` in config; enabled by default.
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

Run several agents in parallel and pick the best result. `excalibur swarm` (or `/swarm` in the interactive shell) fans a task out across isolated **git worktrees** — each agent works on its own copy of the tree — then fans the results back in. Add `--grade` to score the candidates with a rubric and surface the winner. See [workflows.md](workflows.md).

## Agent roles

Workflow phases declare roles, which drive prompts and model routing: `planner`, `architect`, `implementer`, `reviewer`, `tester`, `security`, `release`, plus the Discovery roles (`product_strategist`, `customer_researcher`, `discovery_reviewer`, `ux_reviewer`, `growth_reviewer`, `scope_guardian`).

```yaml
models:
  byRole:
    planner: qwen
    implementer: minimax
    reviewer: qwen
```

## Extending

Programmatic extensions can register additional adapters and tools:

```ts
import { defineExtension, type AgentAdapter } from '@excalibur/extension-sdk';

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
