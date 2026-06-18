import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads the Ink live-render surface (`@excalibur/tui/ink`).
 *
 * Ink + yoga use top-level await and cannot be inlined into the CJS single-file
 * binary, so the published CLI ships the Ink UI as a self-contained ESM sibling
 * (`dist/ink-ui.mjs`) and loads it here via dynamic `import()`:
 * - **Bundled binary** (`__EXCALIBUR_INK_BUNDLED__` defined by tsup): import the
 *   sibling `.mjs` next to `dist/main.js` via a computed path (so esbuild leaves
 *   it as a runtime import).
 * - **Dev / tests** (tsx / vitest): resolve the workspace package directly.
 *
 * Lazy + dynamic so non-TTY runs never pay the Ink/React load cost.
 */

// Replaced with `true` by tsup `define` in the bundled CJS build; `undefined`
// (via typeof guard) when running from source under tsx/vitest.
declare const __EXCALIBUR_INK_BUNDLED__: boolean | undefined;

export type InkUi = typeof import('@excalibur/tui/ink');

export async function loadInkUi(): Promise<InkUi> {
  if (typeof __EXCALIBUR_INK_BUNDLED__ !== 'undefined' && __EXCALIBUR_INK_BUNDLED__) {
    const url = pathToFileURL(join(__dirname, 'ink-ui.mjs')).href;
    return import(url) as Promise<InkUi>;
  }
  return import('@excalibur/tui/ink');
}
