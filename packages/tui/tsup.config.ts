import { defineConfig } from 'tsup';

// Two entries:
// - `rail`     — the PURE reducer/string renderer (NO Ink/React); the catch-all
//                consumer surface. Ink/React are not imported here.
// - `ink/index`— the React/Ink live-render components. Ink + React stay EXTERNAL
//                here (this build is for dev/test/vitest consumption, where the
//                workspace node_modules resolve them). The CLI re-bundles this
//                entry into a SELF-CONTAINED ESM sibling for the published binary
//                (Ink + yoga use top-level await → cannot be frozen into CJS).
export default defineConfig({
  entry: { rail: 'src/rail.ts', 'ink/index': 'src/ink/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
