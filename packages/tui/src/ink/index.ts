/**
 * The INK entry of `@excalibur/tui` — the React/Ink live-render surface, kept
 * SEPARATE from the pure `rail.ts` barrel so the pure reducer/string renderer
 * never pulls the Ink runtime. The CLI imports this entry only on the TTY
 * branch (and ships it as a self-contained ESM sibling bundle, because Ink +
 * yoga use top-level await and cannot be frozen into the CJS single-file).
 *
 * Source of truth stays `reduceRail` → `RailModel`; these components are one of
 * its two presenters (Ink for TTY; `renderRail` strings for non-TTY/CI).
 */
export { ThemeProvider, useColors } from './ThemeContext.js';
export { RunView, type RunViewProps, type RunViewLabels } from './RunView.js';
export {
  mountRunView,
  type MountRunViewOptions,
  type RunViewHandle,
} from './mount.js';
export {
  createRunViewStore,
  applyRunViewKey,
  type RunViewStore,
  type RunViewSnapshot,
  type ApprovalAnswer,
  type KeyFlags,
} from './store.js';
