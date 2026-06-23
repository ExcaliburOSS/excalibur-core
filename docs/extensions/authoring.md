# Authoring a programmatic extension

A programmatic extension is a small TypeScript package that default-exports an
extension built with **[`@excalibur-oss/extension-sdk`](https://www.npmjs.com/package/@excalibur-oss/extension-sdk)**
(published on npm, self-contained — its only runtime dependency is `zod`).
Excalibur loads it, calls `register(ctx)`, and your contributions register
against the typed registries on `ctx`.

This page is the quick start; see [programmatic-extensions.md](programmatic-extensions.md)
for the full reference, the per-kind guides (e.g. [creating-a-tool.md](creating-a-tool.md),
[creating-a-work-item-provider.md](creating-a-work-item-provider.md)), the
[manifest](extension-manifest.md), the [security model](security-model.md) and
[publishing](publishing-extensions.md).

## Scaffold

```bash
excalibur extensions create tool my-extension
# types: methodology · workflow · question-pack · prompt-template · artifact-template ·
#        policy-preset · model-routing · report-template · role-definition · command-mapping ·
#        work-item-provider · communication-provider · model-provider · agent-adapter · tool
```

This writes a typed starter that already imports `@excalibur-oss/extension-sdk`
and pins it as a dependency — `npm install` and it resolves.

## Minimal extension

```ts
import { defineExtension } from '@excalibur-oss/extension-sdk';

export default defineExtension({
  id: 'my-extension', // required: stable id
  name: 'My Extension',
  version: '0.1.0',
  register(ctx) {
    ctx.tools.registerTool({
      name: 'greet',
      description: 'Greet a name',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      async execute(input, context) {
        const name = (input as { name?: unknown }).name;
        if (typeof name !== 'string') {
          return { success: false, output: '', error: 'name is required' };
        }
        context.logger.info(`greeting ${name}`);
        return { success: true, output: `Hello, ${name}` };
      },
    });
  },
});
```

`ctx` exposes one registry per contribution kind: `ctx.methodologies`,
`ctx.workflows`, `ctx.workItems`, `ctx.communication`, `ctx.models`,
`ctx.agents`, `ctx.tools`, `ctx.contextSources`, `ctx.policies`, `ctx.reports`,
`ctx.exporters` — plus `ctx.hooks` (lifecycle events), `ctx.logger` and
`ctx.config`. Each registry exposes a typed `register*` method
(`ctx.tools.registerTool`, `ctx.models.registerProvider`,
`ctx.agents.registerAdapter`, `ctx.workItems.registerProvider`, …) and all
contribution interfaces are exported as types from the package.

## Manifest, capabilities & permissions

An extension declares a manifest (`excalibur.extension.yaml`) with the
capabilities it needs and the permissions backing them (network hosts, filesystem
scopes, secrets env names, allowed commands). Declare the **minimum** required.

## Governance (enforcement)

By default the runtime WARNS on over-broad or undeclared permissions. A project
can turn that into a hard block via `config.extensions`:

```yaml
extensions:
  enforce: true # refuse violating extensions (code never runs)
  allowedCapabilities: [work_items.read, work_items.comment]
  deniedCapabilities: [secrets.read]
  locks: { my-extension: 0.1.0 } # pin exact versions; a drift is blocked
```

Under `enforce`, a local/third-party extension that requests wildcard network,
writes outside `.excalibur/`, reads high-risk paths, uses a denied/non-allowed
capability, or drifts from its lock is **blocked before its entrypoint is
required** — so its code never executes. Built-ins are first-party and exempt.

## Publish

A built extension publishes like any npm package (its consumers install it +
`@excalibur-oss/extension-sdk`). See [publishing-extensions.md](publishing-extensions.md).
