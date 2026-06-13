import { defineConfig } from 'tsup';

// Builds the `excalibur` binary as a single self-contained file.
//
// The catch-all noExternal inlines every dependency — the 12 @excalibur/*
// workspace packages and the third-party libs (commander, picocolors, yaml,
// zod, fast-glob, minimatch) — so the published package ships with ZERO runtime
// dependencies and `npm install -g` pulls exactly one package: the Claude Code
// install model. Node built-in modules (node:fs, …) are always kept external by
// tsup, even under the catch-all.
//
// The entry's `#!/usr/bin/env node` shebang (in src/main.ts) is preserved by
// esbuild, so the bundled dist/main.js is directly executable as the bin.
export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  noExternal: [/.*/],
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  shims: false,
  minify: false,
});
