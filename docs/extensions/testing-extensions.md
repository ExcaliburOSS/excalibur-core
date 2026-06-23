# Testing Extensions

Excalibur's own packages are tested with [vitest](https://vitest.dev); the
patterns below use it, but everything works with any runner.

## Validating declarative files in tests

Parse your YAML/Markdown with the **real** schemas from
`@excalibur/declarative-schemas` — the same code the runtime uses:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDeclarativeYaml, parseDeclarativeMarkdown } from '@excalibur/declarative-schemas';

describe('safe-refactor-strict workflow', () => {
  it('validates and keeps the approval gates', () => {
    const yaml = readFileSync('workflows/safe-refactor-strict.yaml', 'utf8');
    const workflow = parseDeclarativeYaml(yaml, 'workflow');
    const approvals = workflow.phases.filter((phase) => phase.type === 'human_approval');
    expect(approvals).toHaveLength(2);
    expect(approvals.every((phase) => phase.approval === 'required')).toBe(true);
  });
});
```

`parseDeclarativeYaml(text, expectedType?)` throws
`WorkflowValidationError` with the offending field path in the message;
`parseDeclarativeMarkdown(filePath, content)` does the same for Markdown
templates (and lets you assert the auto-extracted `variables`).

Validate the manifest with `validateManifest` / `loadManifest` from
`@excalibur/extension-runtime`:

```ts
import { loadManifest, validatePermissions } from '@excalibur/extension-runtime';

const manifest = loadManifest('excalibur.extension.yaml'); // throws on invalid
expect(validatePermissions(manifest)).toEqual([]); // no warnings expected
```

## Testing a programmatic extension's `register()`

`registerExtension` builds a real `ExtensionContext` over a fresh
`ContributionRegistry`/`HookRegistry` and awaits `register()` — perfect for
unit tests:

```ts
import { describe, expect, it } from 'vitest';
import {
  ContributionRegistry,
  HookRegistry,
  registerExtension,
} from '@excalibur-oss/extension-sdk';
import extension from '../src/index';

describe('register', () => {
  it('contributes the agent adapter', async () => {
    const contributions = new ContributionRegistry();
    const hooks = new HookRegistry();

    await registerExtension(extension, { contributions, hooks });

    const adapter = contributions.get('agent_adapter', 'acme-agent');
    expect(adapter).toBeDefined();
    expect(adapter?.extensionId).toBe('programmatic-custom-command-agent');
    expect(contributions.warnings()).toEqual([]);
    expect(hooks.handlerCount('run.completed')).toBe(1);
  });
});
```

Pass `config`/`logger` through the input to test configuration handling
(`registerExtension(extension, { contributions, hooks, config: { command: 'other' } })`);
a capturing logger is a three-line stub.

## Testing providers, tools and hooks

- **Providers**: call the interface methods directly with hand-built inputs;
  assert normalized outputs and that failures throw `ProviderError`. For
  work items, `MockWorkItemProvider` from `@excalibur/work-items` is a
  deterministic in-memory reference (seeded `DEMO-1..3`) that records
  comments and status updates for assertions.
- **Tools**: call `execute(input, context)` with a minimal `ToolContext`
  (`{ workdir, config: {}, logger }`) and assert the `ToolResult` — including
  the `{ success: false, error }` paths for bad input.
- **Hooks**: `HookRegistry` is directly instantiable. `emit` awaits handlers
  sequentially and isolates failures into `errors()`:

```ts
const hooks = new HookRegistry();
hooks.on('run.completed', () => {
  throw new Error('boom');
});
await hooks.emit('run.completed', { runId: 'run_1' }); // does not throw
expect(hooks.errors()).toHaveLength(1);
```

## End-to-end: through the real loader

Copy your extension into a temp repo and run `loadExtensions` — this
exercises manifest loading, file parsing, conflict rules and permission
warnings exactly as the CLI does:

```ts
import { mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadExtensions } from '@excalibur/extension-runtime';
import { BUILT_IN_EXTENSIONS } from '@excalibur/built-in-extensions';

const repoRoot = mkdtempSync(join(tmpdir(), 'ext-test-'));
cpSync('path/to/my-extension', join(repoRoot, '.excalibur', 'extensions', 'my-extension'), {
  recursive: true,
});

const registry = await loadExtensions({ repoRoot, builtIns: BUILT_IN_EXTENSIONS });
const mine = registry.getExtension('my-extension');
expect(mine?.status).toBe('loaded');
expect(registry.contributions.warnings()).toEqual([]);
```

For programmatic extensions remember the loader needs the **compiled**
`dist/index.js` — build before the end-to-end test, or scope that test to CI
steps that run after the build.

## From the CLI

```bash
excalibur extensions validate   # manifests + every reachable declarative file; exit 2 on invalid
excalibur extensions doctor     # load errors, missing entrypoints, permission warnings
excalibur extensions list       # contributions with their source (built_in/project/local)
```
