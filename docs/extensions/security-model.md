# Extension Security Model

The two extension kinds have fundamentally different risk profiles, and the
architecture is built around that difference.

## Declarative extensions are safe by design

YAML/Markdown extensions run **no code**. They are parsed, validated against
zod schemas, and become data in the contribution registry. The worst a
malformed file can do is fail validation — the loader records a readable
warning and continues; it never crashes and never executes anything.

Two caveats still deserve review when adopting third-party declarative
content:

- **Policy presets and workflows change behavior.** A workflow without
  `human_approval` phases, or a policy preset that allows more than your
  team's default, changes what an agent is allowed to do. Review them like
  configuration, because they are.
- **Prompt templates are model input.** A hostile prompt template is a
  prompt-injection vector. Read templates before installing them.

## Programmatic extensions are code running with your privileges

A local programmatic extension's compiled entrypoint is loaded with
`require()` **in-process**: there is no OS-level sandbox, so an extension whose
entrypoint Excalibur runs can do anything your user account can do at load time.
Permission **enforcement** (below) hard-blocks an over-reaching extension
_before_ its entrypoint is required — but once an extension is allowed to load,
treat installing it exactly like adding an npm dependency:

- Read the source (or build from source you trust) before
  `excalibur extensions install`.
- Prefer extensions that declare narrow `permissions` and few
  `capabilities`.
- The loader requires compiled JS and never runs package install scripts or
  builds for you — what you audit is what runs.

Load failures are isolated per-extension (`status: 'error'`, surfaced by
`excalibur extensions doctor`); hook handler failures are isolated per-emit
and never break a run.

## The permission model

Manifests declare access in ten categories: `network`, `filesystem`,
`process`, `secrets`, `git`, `work_items`, `communication`, `models`,
`tools`, `context`.

```yaml
permissions:
  network:
    allowedHosts: [api.linear.app]
  filesystem:
    read: ['.excalibur/**']
    write: ['.excalibur/runs/**']
  process:
    allowedCommands: [acme-agent]
  secrets:
    env: [LINEAR_API_KEY]
```

### Validation (always on) and enforcement (opt-in, ships today)

**Validation** always runs. `validatePermissions` (invoked automatically by the
loader and by `excalibur extensions validate` / `doctor`) warns about:

- wildcard network hosts (`*` anywhere in a host);
- filesystem **write** patterns outside `.excalibur/` (broad write access is
  high-risk);
- wildcard `process.allowedCommands`;
- `secrets.env` entries that do not look like environment variable names
  (UPPER*SNAKE_CASE) — a guard against secret \_values* leaking into
  manifests;
- unknown permission categories;
- `kind: declarative` extensions declaring permissions (no effect — they run
  no code);
- programmatic extensions declaring `capabilities` without any backing
  `permissions`.

**Enforcement** turns those warnings into a hard block. Set it in
`.excalibur/config.yaml`:

```yaml
extensions:
  enforce: true # refuse a violating extension — its code never runs
  allowedCapabilities: [work_items.read, work_items.comment]
  deniedCapabilities: [secrets.read]
  locks: { acme-agent: 1.2.0 } # pin exact versions; a drift is blocked
```

Under `enforce`, a local/third-party extension that requests wildcard network,
writes outside `.excalibur/`, reads high-risk paths, uses a denied or
non-allowed capability, or drifts from its version lock is **blocked before its
entrypoint is `require()`d** — so its code never executes. First-party built-ins
are exempt. Declaring accurate, minimal permissions means your extension keeps
loading when a project turns enforcement on. Excalibur Enterprise adds the same
controls centrally (org/team/repo policy, hosted secrets, audit logs).

## Secrets

- Manifests and `ctx.config` carry environment variable **names**
  (`apiKeyEnv: LINEAR_API_KEY`), never values. The host resolves names to
  values at call time.
- Never write secret values into `.excalibur/` artifacts, events or logs —
  artifacts are designed to be Git-committable. `redactSecrets` from
  `@excalibur/model-gateway` masks common token shapes (API keys, bearer
  headers, private key blocks) and is applied to prompt assembly; apply it
  yourself to anything you emit from an extension.
- Extensions must not print: there is no `console.log` in packages.
  `ctx.logger` routes through the host, which controls redaction and
  verbosity.

## Tool output and prompt injection

Tool results (`ToolResult.output`) and context documents
(`ContextDocument.content`) are fed to models. If your extension fetches
external content (tickets, wiki pages, web responses), that content can
contain adversarial instructions. Keep outputs scoped and factual; never
include credentials in output; prefer structured `data` for programmatic
consumers.

## Disabling and removing

`.excalibur/extensions.yaml` `disabled:` skips an extension entirely at load
time (`excalibur extensions disable <id>`); listing an id in both `enabled`
and `disabled` resolves to disabled, with a warning. Removing an installed
directory under `.excalibur/extensions/` removes it completely. Built-ins can
be disabled by id too (e.g. `core-prompts`).

## OSS vs Enterprise

OSS Excalibur is local-first: local declarative + local programmatic +
built-ins, validation, **opt-in permission enforcement** (`extensions.enforce`
with capability allow/deny and version locks) and scaffolding. Excalibur
Enterprise adds the same controls **centrally**: org/team/repo enablement,
org-managed enforced permissions, hosted secrets, fleet-wide version pinning
and audit logs.
