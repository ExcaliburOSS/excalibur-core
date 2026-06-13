# Agents

The **Agent Runtime** executes the working phases of a workflow through pluggable *agent adapters*.

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

Adapters emit the canonical Excalibur event stream (`tool_call`, `file_read`, `file_write`, `command_started`, `test_result`, `patch_generated`, …), which the engine forwards to your terminal and to `events.jsonl`.

## Built-in adapters

### `native`

The default adapter, built on the Model Gateway and nine native tools:

`read_file · write_file · list_files · search_code · run_command · git_diff · apply_patch · create_branch · run_tests`

Every tool call passes through the **Permission Engine**: blocked paths are denied, mutating tools default to *ask*, commands outside the allowlist require confirmation (see [security.md](security.md)).

> **M1 behavior.** The native adapter produces a scripted, realistic event stream from the mock provider. It **never touches your filesystem** — file writes and command executions are events marked `simulated: true`, and generated diffs travel inside the `patch_generated` event payload. The real tool loop arrives in M2.

### `custom-command`

Wraps any CLI coding agent (Claude Code, Aider, Codex CLI, …) as an adapter. Configuration shape (activates in M3):

```yaml
agents:
  default: native
  claude-code:
    type: custom-command
    command: "claude"
    args: ["--print", "{{prompt}}"]
  aider:
    type: custom-command
    command: "aider"
    args: ["--message", "{{prompt}}"]
```

In M1 `detect()` is real (checks the binary on PATH) and `run()` honestly reports that execution activates in M3.

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

Programmatic extensions can register additional adapters:

```ts
import { defineExtension, type AgentAdapter } from '@excalibur/extension-sdk';

export default defineExtension({
  id: 'my-agent',
  name: 'My Agent',
  version: '0.1.0',
  register(ctx) {
    ctx.agents.registerAdapter(new MyAdapter());
  },
});
```

Scaffold one with `excalibur extensions create agent-adapter my-agent`. See [extensions/programmatic-extensions.md](extensions/programmatic-extensions.md).
