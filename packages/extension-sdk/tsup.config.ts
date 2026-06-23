import { defineConfig } from 'tsup';

/**
 * The SDK ships SELF-CONTAINED so an external extension author needs only
 * `@excalibur-oss/extension-sdk` (+ zod). The `@excalibur/*` workspace packages
 * are devDependencies, so tsup inlines their RUNTIME by default; `dts.resolve`
 * makes the type bundler do the same for their `.d.ts`, so the published types
 * carry no bare `@excalibur/*` imports a consumer couldn't resolve. Only `zod`
 * stays external (it is the package's one real dependency).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: { resolve: [/^@excalibur\//] },
  sourcemap: true,
  clean: true,
  external: ['zod'],
});
