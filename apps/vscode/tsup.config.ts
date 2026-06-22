import { defineConfig } from 'tsup';

/**
 * Bundle the extension to a single CommonJS file (VS Code `require`s `main`).
 * `vscode` is provided by the host at runtime and MUST be externalized — it is
 * not an npm package. No runtime deps are bundled (the ACP client is hand-rolled),
 * so the .vsix ships just `dist/extension.js`.
 */
export default defineConfig({
  entry: { extension: 'src/extension.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
  external: ['vscode'],
  clean: true,
  dts: false,
  sourcemap: false,
  minify: false,
});
