/**
 * The PURE rail entry of `@excalibur/tui` — `reduceRail` + `renderRail` + the
 * rail types, with NO Ink/React imports, so the CLI (and any consumer) can fold
 * an ExcaliburEvent stream into the LIVING RAIL and render it as text without
 * bundling the whole Ink runtime. The Ink `<PhaseTimeline>` lives separately and
 * is only pulled in by the interactive TTY shell.
 */
export { reduceRail, type ReduceRailOptions } from './rail-reducer.js';
export { renderRail, type RenderRailOptions } from './rail-render.js';
export { renderTodos, type RenderTodosOptions } from './rail-todos.js';
export type { TodoItem } from './rail-types.js';
export {
  renderPlanCard,
  type PlanCardModel,
  type PlanPhase,
  type RenderPlanCardOptions,
} from './rail-plan.js';
export { detectColorTier, paint, paintBg, stripAnsi, type ColorTier } from './color.js';
export { parseDiffStat, formatDiffStat, type DiffStat } from './diff-stat.js';
export {
  parseUnifiedDiff,
  renderDiff,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type DiffLineKind,
  type RenderDiffOptions,
} from './diff-view.js';
export {
  renderLanes,
  type LaneModel,
  type LaneState,
  type LanesModel,
  type RenderLanesOptions,
} from './rail-lanes.js';
export {
  detectThemeSync,
  getColors,
  paletteFor,
  THEME_NAMES,
  type ThemeMode,
  type ThemeName,
  type Palette,
} from './theme.js';
export type {
  ApprovalPrompt,
  Phase,
  PhaseEvent,
  PhaseState,
  RailModel,
  RunStatus,
} from './rail-types.js';
