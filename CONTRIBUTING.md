# Contributing to Excalibur Core

Thanks for your interest in Excalibur Core! This is the open-source (Apache-2.0)
CLI + packages. Contributions of all kinds are welcome — bug reports, docs, and
code.

## Prerequisites

- **Node.js ≥ 22** (see `.nvmrc`).
- **pnpm** — this repo pins its version via the `packageManager` field; the
  easiest way is `corepack enable` (ships with Node), which makes `pnpm` use the
  pinned version automatically.

## Setup

```bash
git clone https://github.com/ExcaliburOSS/excalibur-core.git
cd excalibur-core
pnpm install
pnpm -r build      # build all packages (also needed before typecheck)
```

Run the CLI from source:

```bash
node apps/cli/dist/main.js --help     # the built binary
# or, during development:
pnpm --filter @excalibur-oss/excalibur exec tsx src/main.ts --help
```

By default Excalibur runs on a built-in **mock** provider (no API key, offline).
Configure a real provider in `.excalibur/models/providers.yaml` (see
[docs/providers.md](docs/providers.md)) for real model-driven work.

## Dev loop

Run these before opening a PR (this is what CI runs):

```bash
pnpm -r build       # build (required before typecheck — see below)
pnpm -r typecheck   # tsc --noEmit across every package
pnpm lint           # eslint
pnpm -r test        # vitest across every package
pnpm format         # prettier --write (format your changes)
```

> **Why build before typecheck?** The CLI resolves the `@excalibur/tui/ink`
> subpath types from the built `dist/` (via `typesVersions`), so `dist` must
> exist before `typecheck`.

There is also a real-model smoke suite (`pnpm verify:real`) that exercises every
command against a real provider. It needs a configured provider + key and makes
real model calls, so it is **not** part of CI — run it locally when changing the
agent loop, run pipeline, or a command's behavior.

## Repository layout

- `apps/cli` — the `excalibur` CLI (`@excalibur-oss/excalibur`), built as a single
  self-contained binary.
- `packages/*` — `@excalibur/{shared, workflow-schema, model-gateway,
agent-runtime, context-engine, core, tui, enterprise-sync, work-items,
extension-runtime, extension-sdk, built-in-extensions, declarative-schemas}`.
- `docs/` — user docs + `docs/CONTRACT.md` (the engineering build contract) +
  `docs/ROADMAP.md` (the M1–M8 master roadmap).

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`), optionally scoped (`feat(swarm): …`).
- Keep changes focused; match the style and comment density of the surrounding
  code. New behavior needs tests.
- Never commit secrets. Real provider keys live in env vars referenced by
  `providers.yaml` (by **name**, never the value) — never in the repo.

## Reporting bugs / requesting features

Open a GitHub issue with steps to reproduce (and `excalibur doctor` output for
environment issues). Security-sensitive reports: please disclose privately first.
