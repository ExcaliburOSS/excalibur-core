/**
 * The ESM entry the CLI bundles into a SELF-CONTAINED sibling `dist/ink-ui.mjs`
 * (Ink + React + yoga inlined). Ink and yoga use top-level await, so they cannot
 * be frozen into the CJS single-file `dist/main.js`; the CJS CLI loads this ESM
 * sibling via dynamic `import()` on the TTY branch (see `./load.ts`). Re-exports
 * the whole Ink surface of `@excalibur/tui/ink`.
 */
export * from '@excalibur/tui/ink';
