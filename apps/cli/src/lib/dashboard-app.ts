import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Loads the embedded Svelte dashboard (D0). The dashboard is a single
 * self-contained `index.html` (JS + CSS inlined by Vite); `apps/cli`'s build
 * copies it to `dist/dashboard.html` next to the bundle, and this resolves it at
 * runtime so `excalibur serve` can return it at `/`.
 *
 * Resolution avoids `__dirname`/`import.meta` (the bundle is CJS, the tests run
 * the source) by walking a list of plausible locations relative to the running
 * entry script and the cwd. Returns null when no built asset is found — the
 * caller then falls back to the legacy inline dashboard, so `serve` always works
 * even before the dashboard has been built.
 */

let cached: string | null | undefined;

function candidatePaths(): string[] {
  const paths: string[] = [];
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry.length > 0) {
    const entryDir = dirname(entry);
    // Published / built: dashboard.html sits next to dist/main.js.
    paths.push(join(entryDir, 'dashboard.html'));
    paths.push(join(entryDir, '..', 'dashboard.html'));
  }
  // Monorepo dev / tests: read straight from the build outputs.
  const cwd = process.cwd();
  paths.push(join(cwd, 'apps', 'cli', 'dist', 'dashboard.html'));
  paths.push(join(cwd, 'apps', 'dashboard', 'dist', 'index.html'));
  paths.push(join(cwd, '..', 'dashboard', 'dist', 'index.html'));
  return paths;
}

/** The built dashboard HTML, or null if it hasn't been built/shipped. Cached. */
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
  cached = null;
  return cached;
}

/** Test-only: reset the memoized lookup. */
export function resetDashboardAppCache(): void {
  cached = undefined;
}
