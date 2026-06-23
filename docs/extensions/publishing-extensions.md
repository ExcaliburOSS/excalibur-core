# Publishing Extensions

## Honest status first

There is **no Excalibur npm extension ecosystem yet**. Installing extensions
from npm (`excalibur extensions install <npm-package>`) arrives with the npm
ecosystem milestone (M8); today the CLI prints an honest notice for npm
sources. Everything below the "What works today" line works right now.

## What works today

### 1. In-repo, Git-versioned (recommended for teams)

Declarative content committed to the repository is the simplest distribution
mechanism there is — it travels with the code, gets reviewed in PRs, and
loads automatically:

```text
.excalibur/
  workflows/safe-hotfix.yaml        # loose declarative files
  methodologies/safe-refactor-strict.yaml
  extensions/
    internal-tools/                  # installed extensions (packs or programmatic)
      excalibur.extension.yaml
      dist/index.js
```

### 2. Local install from a path

`excalibur extensions install <path>` validates the extension's manifest and
copies the folder into `.excalibur/extensions/`:

```bash
git clone git@github.com:acme/excalibur-discovery-pack.git /tmp/discovery-pack
excalibur extensions install /tmp/discovery-pack
excalibur extensions validate
```

For programmatic extensions, **build first** — the loader requires the
compiled entrypoint (`dist/index.js`) and never builds for you. This is also
your audit point: read the code you are about to install
(see [security-model.md](./security-model.md)).

### 3. Sharing via a Git repository

Publish the extension folder as its own repo (or a folder in a shared
"extensions" monorepo). Consumers clone and install from the path as above.
A good shareable extension repo contains:

- `excalibur.extension.yaml` — id, version, accurate `contributes`,
  `configSchema` and `permissions`;
- the contributed YAML/Markdown files (declarative) and/or `src/` +
  `dist/` build script (programmatic);
- a `README.md` saying what it contributes, what configuration it needs
  (env var **names** only) and which milestone-gated features it touches;
- tests (see [testing-extensions.md](./testing-extensions.md)).

The five folders under
[`examples/extensions/`](../../examples/extensions/) follow exactly this
layout and can be used as templates, as can
`excalibur extensions create <type> <name>` scaffolds.

## Preparing for the npm ecosystem (M8)

If you publish a programmatic extension to npm _now_ (as a normal package),
nothing consumes it yet — but you can make it future-proof:

- keep `excalibur.extension.yaml` at the package root and `dist/` in the
  published files;
- make the compiled entrypoint CommonJS-compatible (the loader `require()`s
  it) with the `defineExtension(...)` result as the default export;
- pin `@excalibur-oss/extension-sdk` as a regular dependency and follow semver:
  the contribution interfaces are stable, and breaking manifest changes will
  be versioned;
- declare accurate, minimal `permissions` — permission enforcement ships
  today (`extensions.enforce` with capability allow/deny and version locks), so
  a project that turns it on will **deny** an extension whose manifest
  over-reaches; well-declared extensions keep loading without changes (and will
  pass review when the npm registry flow lands in M8).

When M8 lands, `excalibur extensions install <name>` from npm plus
enterprise-managed distribution (org/team/repo enablement, version
management, audit) become the supported channels, and this page will be
updated with the registry workflow.
