# programmatic-custom-command-agent (example)

A **programmatic** extension written with the Extension SDK
(`@excalibur/extension-sdk`). It registers:

- an `AgentAdapter` (`acme-agent`) that wraps an external CLI agent binary —
  `detect()` checks the binary is on `PATH`, `run()` streams canonical
  `ExcaliburEvent`s;
- a `run.completed` hook handler, showing lifecycle hook subscription.

```text
programmatic-custom-command-agent/
  excalibur.extension.yaml   # kind: programmatic, entrypoint: dist/index.js
  package.json               # depends on @excalibur/extension-sdk
  tsconfig.json              # compiles src/ → dist/ (CommonJS)
  src/index.ts               # export default defineExtension({ ... })
```

## What it demonstrates

- `defineExtension({ id, name, version, register(ctx) })` as the default
  export of the compiled entrypoint — that exact shape is what the loader
  looks for.
- `ctx.agents.registerAdapter(...)` — one of the typed registries on
  `ExtensionContext` (others: `workItems`, `communication`, `models`,
  `tools`, `contextSources`, `policies`, `reports`, `exporters`,
  `methodologies`, `workflows`).
- `ctx.config` — values resolved by the host against the manifest's
  `configSchema` (env var _names_ and options only; never secret values).
- `ctx.hooks.on(...)` and `ctx.logger` — extensions never `console.log`.
- Manifest `permissions` for a code-running extension: the process command it
  wraps, and filesystem access scoped to `.excalibur/`.

## Honest M1 status

This example is **documentation only** — CI neither installs nor builds it.

- The extension loader requires a **compiled** entrypoint (`dist/index.js`);
  it never compiles TypeScript for you.
- M1 does not execute external commands inside runs, so the adapter's
  `run()` yields an honest `error` event explaining that external agent
  execution activates in M3. `detect()` is real.
- Permission declarations are validated and produce warnings in M1;
  enforcement lands in M5.

## Build and install it yourself

```bash
cd examples/extensions/programmatic-custom-command-agent

# Inside this monorepo, point the two dependencies at the local packages
# (when the packages are on npm, the package.json versions resolve as-is):
#   "@excalibur/extension-sdk": "file:../../../packages/extension-sdk"
#   "@excalibur/shared":        "file:../../../packages/shared"

npm install
npm run build          # produces dist/index.js

cd <your-repo>
excalibur extensions install <path-to>/programmatic-custom-command-agent
excalibur extensions list      # shows the extension and its agent_adapter
excalibur extensions doctor    # diagnoses a missing/broken entrypoint
```

See `docs/extensions/programmatic-extensions.md` for the SDK reference and
`docs/extensions/security-model.md` before installing any code-running
extension.
