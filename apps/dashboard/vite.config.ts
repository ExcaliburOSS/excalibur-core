import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * The dashboard ships as ONE self-contained `index.html` (JS + CSS inlined by
 * `viteSingleFile`). `apps/cli` copies that single file next to its bundle at
 * build time and `excalibur serve` returns it at `/` — so the OSS user gets the
 * dashboard with zero extra setup, no asset routing, and no second process.
 */
export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // Everything inlined → no chunking; keep the report quiet for one file.
    reportCompressedSize: false,
  },
});
