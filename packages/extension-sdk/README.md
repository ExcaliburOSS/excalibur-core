# @excalibur-oss/extension-sdk

TypeScript SDK for building **Excalibur** extensions — add workflows,
methodologies, work-item providers, model adapters, agent adapters, tools,
context sources, policies, reports and exporters to the
[Excalibur CLI](https://www.npmjs.com/package/@excalibur-oss/excalibur).

An extension is a small package that default-exports an `ExcaliburExtension`.
Excalibur loads it, calls `activate(ctx)`, and your contributions register
against the typed registries on `ctx`.

## Install

```sh
npm install @excalibur-oss/extension-sdk
# or: pnpm add @excalibur-oss/extension-sdk
```

The SDK ships self-contained (its only runtime dependency is `zod`).

## Quick start

```ts
import { defineExtension } from '@excalibur-oss/extension-sdk';

export default defineExtension({
  name: 'my-extension',
  version: '0.1.0',
  activate(ctx) {
    // Register a tool the agent can call mid-run:
    ctx.tools.register({
      name: 'greet',
      description: 'Greet a name',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      readOnly: true,
      async execute(args) {
        return { ok: true, content: `Hello, ${String(args.name)}` };
      },
    });

    ctx.logger.info('my-extension activated');
  },
});
```

Scaffold a typed starter for any contribution type with the CLI:

```sh
excalibur extensions init my-extension --type tool   # or work-item-provider, model-provider, agent-adapter, communication-provider
```

## What you can contribute

`ctx` exposes one registry per contribution type:

| Registry                                                                | Adds                                    |
| ----------------------------------------------------------------------- | --------------------------------------- |
| `ctx.tools`                                                             | agent-callable tools (`AgentTool`)      |
| `ctx.workflows` / `ctx.methodologies`                                   | run workflows + methodologies           |
| `ctx.workItemProviders`                                                 | task trackers (`WorkItemProvider`)      |
| `ctx.modelProviders`                                                    | model adapters (`ModelProviderAdapter`) |
| `ctx.agentAdapters`                                                     | agent loops (`AgentAdapter`)            |
| `ctx.communicationProviders`                                            | Slack/Teams/etc.                        |
| `ctx.contextSources` / `ctx.policies` / `ctx.reports` / `ctx.exporters` | context, governance, reporting          |

All contribution interfaces are exported as types from this package.

## Security

Extensions run under Excalibur's permission model: a tool marked `readOnly`
never mutates, and the host gates network/exec per the active policy. Declare
the minimum capabilities your extension needs.

## License

Apache-2.0
