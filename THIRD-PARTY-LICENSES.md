# Third-Party Licenses

Excalibur is distributed as a self-contained binary: the published packages
(`@excalibur-oss/excalibur`, `@excalibur-oss/extension-sdk`) bundle their runtime
dependencies into `dist/`. This file attributes the primary bundled libraries. Each
is used under its own license (permissive — MIT / ISC / Apache-2.0); the full
license texts ship inside each package under `node_modules/<name>/` and are
available in the package's own repository.

## Primary bundled dependencies

- **commander** 13.1.0 — MIT — © Commander.js contributors
- **picocolors** 1.1.1 — ISC — © Alexey Raspopov
- **undici** 8.5.0 — MIT — © Matteo Collina and undici contributors
- **yaml** 2.9.0 — ISC — © Eemeli Aro
- **zod** 3.25.76 — MIT — © Colin McDonnell
- **ink** 5.2.1 — MIT — © Vadim Demedes (the interactive TUI renderer)
- **react** 18.3.1 — MIT — © Meta Platforms, Inc. and affiliates (drives Ink)
- **yoga-layout** 3.2.1 — MIT — © Meta Platforms, Inc. and affiliates (Ink's layout)
- **defuddle** 0.19.0 — MIT — © Defuddle contributors (readable web extraction)

Each library above also pulls transitive dependencies that are bundled with it;
those are likewise distributed under permissive licenses (predominantly MIT and
ISC). The complete, resolved dependency tree is recorded in `pnpm-lock.yaml`, and
every dependency's license text is present in its `node_modules` package directory.

Excalibur itself is licensed under Apache-2.0 — see [LICENSE](LICENSE).

This list covers the primary libraries inlined into the published binary. If you
find a bundled dependency that is missing or misattributed, please open an issue or
a PR — we'll fix it.
