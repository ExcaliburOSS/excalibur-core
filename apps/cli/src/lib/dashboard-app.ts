import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Loads the embedded Svelte dashboard (D0). The dashboard is a single
 * self-contained `index.html` (JS + CSS inlined by Vite); `apps/cli`'s build
 * copies it to `dist/dashboard.html` next to the bundle, and this resolves it at
 * runtime so `excalibur serve` can return it at `/`.
 *
 * Resolution walks plausible locations relative to the bundle's `__dirname`, the
 * (symlink-resolved) entry script, and the cwd — covering a global install
 * (symlinked bin), a local link, and monorepo dev/tests. Returns null only when
 * no built asset exists anywhere; the caller then shows an honest "not built"
 * page rather than a misleading legacy one.
 */

let cached: string | undefined;

function candidatePaths(): string[] {
  const paths: string[] = [];
  // The published bundle is CJS, so `__dirname` is the REAL `dist/` even when the
  // CLI is launched through a symlinked global bin — which is exactly the case a
  // plain `process.argv[1]` gets wrong (see below). Guarded so the source/ESM/test
  // path (no `__dirname`) just skips it. `typeof` never throws on an undeclared id.
  if (typeof __dirname === 'string' && __dirname.length > 0) {
    paths.push(join(__dirname, 'dashboard.html'));
    paths.push(join(__dirname, '..', 'dashboard.html'));
  }
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry.length > 0) {
    // A global install runs `…/bin/excalibur` → a SYMLINK to `…/dist/main.js`, so a
    // raw `dirname(argv[1])` is `/usr/local/bin` (no dashboard.html there) and the
    // dashboard is never found → every global user fell back to the legacy page.
    // Resolve the symlink so `dirname` lands in the real `dist/`.
    let resolved = entry;
    try {
      resolved = realpathSync(entry);
    } catch {
      /* keep the raw entry */
    }
    for (const e of new Set([resolved, entry])) {
      const entryDir = dirname(e);
      // Published / built: dashboard.html sits next to dist/main.js.
      paths.push(join(entryDir, 'dashboard.html'));
      paths.push(join(entryDir, '..', 'dashboard.html'));
    }
  }
  // Monorepo dev / tests: read straight from the build outputs.
  const cwd = process.cwd();
  paths.push(join(cwd, 'apps', 'cli', 'dist', 'dashboard.html'));
  paths.push(join(cwd, 'apps', 'dashboard', 'dist', 'index.html'));
  paths.push(join(cwd, '..', 'dashboard', 'dist', 'index.html'));
  return paths;
}

/**
 * The built dashboard HTML, or null if it hasn't been built/shipped. Only a
 * SUCCESSFUL read is cached — a miss is not memoized, so a dashboard built after
 * the server started (or a first request that raced the build) is picked up on a
 * later request rather than wedged to the legacy page for the process lifetime.
 */
export function dashboardAppHtml(): string | null {
  if (cached !== undefined) {
    return cached;
  }
  for (const candidate of candidatePaths()) {
    try {
      const html = readFileSync(candidate, 'utf8');
      if (html.length > 0) {
        cached = html;
        return cached;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null; // not found — do NOT cache, so a later call retries
}

/** Test-only: reset the memoized lookup. */
export function resetDashboardAppCache(): void {
  cached = undefined;
}

/**
 * A minimal, HONEST page for the rare case the Svelte dashboard genuinely hasn't
 * been built (dev, before `pnpm -r build`). Replaces the old behaviour of silently
 * serving a different, misleading dashboard.
 */
export function dashboardNotBuiltHtml(): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Excalibur dashboard</title><style>',
    'body{font:15px/1.65 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.5rem;color:#1f2733}',
    'code{background:#eef2ff;color:#2368d0;padding:.15rem .45rem;border-radius:5px;font-size:.9em}',
    'h1{font-size:1.4rem}.m{color:#697586}</style></head><body>',
    '<h1>⚔ Excalibur dashboard</h1>',
    "<p>The web dashboard hasn't been built yet. From the repository root run:</p>",
    '<p><code>pnpm -r build</code></p>',
    '<p class="m">then restart <code>excalibur serve</code>. A published <code>npm</code> install already bundles it.</p>',
    '</body></html>',
  ].join('');
}
