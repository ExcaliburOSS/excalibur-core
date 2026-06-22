#!/usr/bin/env node
/**
 * Copies the built Svelte dashboard (one self-contained index.html, produced by
 * `@excalibur/dashboard`'s Vite build) next to the CLI bundle as
 * `dist/dashboard.html`, so `excalibur serve` can return it at `/`. Runs after
 * tsup (whose `clean` wipes dist first). Best-effort: if the dashboard hasn't
 * been built, it warns and skips — the CLI still serves the legacy inline page.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');
const source = join(cliRoot, '..', 'dashboard', 'dist', 'index.html');
const destDir = join(cliRoot, 'dist');
const dest = join(destDir, 'dashboard.html');

if (!existsSync(source)) {
  console.warn(
    `[copy-dashboard] ${source} not found — build @excalibur/dashboard first. ` +
      `Skipping (serve falls back to the legacy inline dashboard).`,
  );
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
console.log(`[copy-dashboard] embedded dashboard → ${dest}`);
