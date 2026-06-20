import { defineConfig } from 'tsup';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
// The published version, read from package.json and injected via `define` below
// so `excalibur --version` can never drift from the manifest again.
const pkgVersion: string = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version;

// Two outputs make up the published `excalibur` binary:
//
// 1. `dist/main.js` — the CJS single-file bundle. The catch-all noExternal
//    inlines every dependency (the @excalibur/* workspace packages + commander,
//    picocolors, yaml, zod, fast-glob, minimatch …) so the package ships with
//    ZERO runtime deps — the Claude Code install model. The entry's
//    `#!/usr/bin/env node` shebang (src/main.ts) is preserved by esbuild.
//    `@excalibur/tui/ink` is the ONE exception: Ink + yoga use top-level await,
//    which esbuild cannot emit in CJS, so it is kept external and loaded at
//    runtime from the ESM sibling below (see src/ink/load.ts). The `define`
//    flips the loader onto the bundled-sibling path.
//
// 2. `dist/ink-ui.mjs` — a SELF-CONTAINED ESM bundle of the Ink live-render UI
//    (Ink + React + yoga inlined; TLA is legal in ESM). The `createRequire`
//    banner lets bundled CJS deps (signal-exit, …) `require()` Node builtins;
//    `react-devtools-core` (a dev-only Ink import) is aliased to a stub. Still
//    zero external runtime deps — just two self-contained files.
export default defineConfig([
  {
    entry: { main: 'src/main.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    bundle: true,
    // Inline everything EXCEPT the Ink subpath (tsup's noExternal is checked
    // before external, so a bare /.*/ would force-bundle Ink and hit its
    // top-level await). The negative lookahead leaves `@excalibur/tui/ink`
    // external → loaded at runtime from the ESM sibling below.
    noExternal: [/^(?!@excalibur\/tui\/ink$).*/],
    external: ['@excalibur/tui/ink'],
    define: { __EXCALIBUR_INK_BUNDLED__: 'true', __CLI_VERSION__: JSON.stringify(pkgVersion) },
    clean: true,
    sourcemap: false,
    dts: false,
    splitting: false,
    shims: false,
    minify: false,
  },
  {
    entry: { 'ink-ui': 'src/ink/ink-ui-entry.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    bundle: true,
    noExternal: [/.*/],
    banner: {
      js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
    },
    esbuildOptions(options) {
      options.alias = {
        ...(options.alias ?? {}),
        'react-devtools-core': join(here, 'src/ink/devtools-stub.mts'),
      };
    },
    clean: false,
    sourcemap: false,
    dts: false,
    splitting: false,
    shims: false,
    minify: false,
    outExtension: () => ({ js: '.mjs' }),
  },
]);
