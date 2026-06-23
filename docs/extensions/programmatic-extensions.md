# Programmatic Extensions

Programmatic extensions are TypeScript packages built with
`@excalibur-oss/extension-sdk`. Use them when declarative files are not enough:
external APIs, authentication, runtime behavior, agent tools, model
providers, agent adapters, complex policy, custom context, exporters.

## Anatomy

```text
my-extension/
  excalibur.extension.yaml   # kind: programmatic (or mixed), entrypoint: dist/index.js
  package.json               # depends on @excalibur-oss/extension-sdk
  tsconfig.json              # compiles src/ → dist/ (CommonJS-compatible)
  src/index.ts               # export default defineExtension({ ... })
  dist/index.js              # the compiled entrypoint the loader require()s
```

The entrypoint must be **compiled JavaScript** — the loader never compiles
TypeScript. The `defineExtension(...)` result must be the module's default
export (a CommonJS `module.exports` works too).

## `defineExtension`

```ts
import { defineExtension } from '@excalibur-oss/extension-sdk';

export default defineExtension({
  id: 'linear', // must match the manifest id
  name: 'Linear',
  version: '0.1.0',
  description: 'Optional.',
  register(ctx) {
    // sync or async; called once at load time
    ctx.workItems.registerProvider(new LinearWorkItemProvider());
  },
});
```

`defineExtension` validates the definition (non-empty `id`/`name`/`version`,
no whitespace in `id`, `register` is a function) and returns a frozen object.
Structural problems throw `ExtensionDefinitionError` (an `ExcaliburError`,
code `extension_definition`). If the exported `id` differs from the manifest
`id`, the manifest wins and a warning is recorded.

## `ExtensionContext`

`register(ctx)` receives the context with 11 typed registries plus hooks,
logger and config:

| Property             | Registers                                                | Method                                                                               |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ctx.methodologies`  | declarative `methodology` definitions                    | `register(definition)`                                                               |
| `ctx.workflows`      | declarative `workflow` definitions                       | `register(definition)`                                                               |
| `ctx.workItems`      | `WorkItemProvider` (from `@excalibur/work-items`)        | `registerProvider(provider)`                                                         |
| `ctx.communication`  | `CommunicationProvider`                                  | `registerProvider(provider)`                                                         |
| `ctx.models`         | `ModelProviderAdapter` (from `@excalibur/model-gateway`) | `registerProvider(provider)`                                                         |
| `ctx.agents`         | `AgentAdapter` (from `@excalibur/agent-runtime`)         | `registerAdapter(adapter)`                                                           |
| `ctx.tools`          | `AgentTool`                                              | `registerTool(tool)`                                                                 |
| `ctx.contextSources` | `ContextSource`                                          | `registerSource(source)`                                                             |
| `ctx.policies`       | `PolicyEvaluator`                                        | `registerEvaluator(evaluator)`                                                       |
| `ctx.reports`        | `ReportGenerator`                                        | `registerGenerator(generator)`                                                       |
| `ctx.exporters`      | `Exporter`                                               | `registerExporter(exporter)`                                                         |
| `ctx.hooks`          | lifecycle hook handlers                                  | `on(hookName, handler)`                                                              |
| `ctx.logger`         | —                                                        | `info/warn/error(msg)`                                                               |
| `ctx.config`         | —                                                        | `Record<string, unknown>` resolved by the host against the manifest's `configSchema` |

Every registry is a thin typed wrapper over the runtime's
`ContributionRegistry`: it validates the contribution's identity (non-empty
id/type/name, required methods present — throwing `ExtensionDefinitionError`
otherwise), stamps your extension id and source, and delegates. Conflict and
override rules stay in the runtime (see
[overview.md](./overview.md#how-extensions-are-loaded)).

Methodologies and workflows registered through `ctx.methodologies` /
`ctx.workflows` are validated with the same schemas as YAML files; invalid
definitions throw `WorkflowValidationError`.

Never use `console.log` — use `ctx.logger`. The default logger is a silent
no-op; the host (CLI or Enterprise runtime) injects a real one.

## Hooks

```ts
ctx.hooks.on<{ runId: string }>('run.completed', async (event) => {
  // notify, export, annotate…
});
```

The well-known hook names (`EXCALIBUR_HOOKS`):
`workItem.received`, `workItem.commandDetected`, `discovery.started`,
`discovery.completed`, `interaction.created`, `patch.created`,
`run.created`, `run.phaseStarted`, `run.phaseCompleted`, `run.completed`,
`run.failed`, `pr.opened`, `dailySummary.generating`,
`weeklyPlanning.started`.

`emit` awaits handlers sequentially in registration order and **isolates
failures**: a throwing handler never breaks the emitting run; errors are
collected on the registry (`errors()`).

## Loading semantics

- The loader reads your manifest, `require()`s the compiled entrypoint and
  checks it exports a `defineExtension` result. Failures (missing entrypoint,
  bad export, thrown module code) are recorded on the extension
  (`status: 'error'`, shown by `excalibur extensions doctor`) — they never
  crash Excalibur.
- Programmatic contribution names listed in the manifest's `contributes`
  (e.g. `agentAdapters: [acme-agent]`) are registered in the contribution
  registry pointing at your extension.
- Contributions are **live**: extension **tools** are callable by the model in
  real agentic runs, **model providers** and **agent adapters** drive real runs,
  and **context sources / reports / policies** are consulted by the engine. Real
  streaming model calls, real file mutation and real command execution all ship
  today. Remote **work-item** and **communication** providers (Linear/Jira,
  Slack/Teams) are the integrations still landing — write to the stable
  interfaces now and keep honest error messages only for paths a given
  deployment hasn't wired up.
- When `config.extensions.enforce` is on, a local/third-party extension whose
  manifest over-reaches (wildcard network, writes outside `.excalibur/`, denied
  capability, lock drift) is **blocked before its entrypoint is `require()`d** —
  so declare the minimum permissions you actually need.

## Testing and security

See [testing-extensions.md](./testing-extensions.md) for unit-testing
`register()` with `registerExtension`/`createExtensionContext`, and
[security-model.md](./security-model.md) — a programmatic extension is code
running with your privileges; declare `permissions` in the manifest.

Working example:
[`examples/extensions/programmatic-custom-command-agent`](../../examples/extensions/programmatic-custom-command-agent/).
