# Creating a Tool

Tools extend what agents can _do_: query an internal database, fetch a ticket,
call an internal service. A tool is a **programmatic** contribution
implementing the `AgentTool` interface from `@excalibur-oss/extension-sdk`; once
registered it sits alongside the native tools of `@excalibur/agent-runtime`
(`read_file`, `write_file`, `list_files`, `search_code`, `run_command`,
`git_diff`, `apply_patch`, `create_branch`, `run_tests`).

## The interface

```ts
import type { AgentTool, ToolContext, ToolResult } from '@excalibur-oss/extension-sdk';

export const fetchTicketTool: AgentTool = {
  name: 'fetch_ticket', // unique tool name
  description: 'Fetches a ticket by key from the internal tracker.',
  inputSchema: {
    // JSON-schema-like; shown to the model
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Ticket key, e.g. ACME-123' },
    },
    required: ['key'],
  },
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const key = (input as { key?: unknown }).key;
    if (typeof key !== 'string' || key.length === 0) {
      return { success: false, output: '', error: 'key must be a non-empty string' };
    }
    context.logger.info(`fetching ${key}`);
    // … call the tracker …
    return {
      success: true,
      output: `# ${key}\n…markdown the model can read…`,
      data: { key }, // optional structured payload
    };
  },
};
```

`ToolContext` gives you `workdir` (absolute working directory), optional
`runId`/`sessionId`/`role` for attribution, the effective `config`
(`ExcaliburConfig`) and a `logger`. Always return a `ToolResult` —
`{ success: false, error }` for expected failures — rather than throwing for
control flow; reserve exceptions for bugs.

Validate `input` yourself (it arrives as `unknown` from the model); a zod
schema is the natural companion to `inputSchema`.

## Register it

```ts
import { defineExtension } from '@excalibur-oss/extension-sdk';
import { fetchTicketTool } from './fetch-ticket';

export default defineExtension({
  id: 'internal-tools',
  name: 'Internal Tools',
  version: '0.1.0',
  register(ctx) {
    ctx.tools.registerTool(fetchTicketTool);
  },
});
```

`registerTool` validates the shape (non-empty `name` and `description`, an
`execute` function) and registers a `tool` contribution.

## The manifest

```yaml
id: internal-tools
name: Internal Tools
version: 0.1.0
kind: programmatic
entrypoint: dist/index.js
contributes:
  tools:
    - fetch_ticket
capabilities:
  - tools.execute
permissions:
  network:
    allowedHosts: [tracker.internal.acme.com]
  secrets:
    env: [TRACKER_API_TOKEN]
```

Declare exactly what the tool touches — tools run with your privileges, and
their output is fed to a model. See
[security-model.md](./security-model.md), including the note on prompt
injection via tool output.

## Scaffold and validate

```bash
excalibur extensions create tool fetch-ticket
cd .excalibur/extensions/fetch-ticket && npm install && npm run build
excalibur extensions validate
```

## Honest M1 status

Registered tools load and validate today, but M1 runs do not execute
extension tools (M1 runs never execute real commands at all — events are
simulated). Tool execution inside runs activates when real agent execution
lands (M3). Implement and unit-test `execute()` now — calling it directly in
vitest with a hand-built `ToolContext` works today (see
[testing-extensions.md](./testing-extensions.md)).
