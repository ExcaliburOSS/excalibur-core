/**
 * The PURE rail entry of `@excalibur/tui` — `reduceRail` + `renderRail` + the
 * rail types, with NO Ink/React imports, so the CLI (and any consumer) can fold
 * an ExcaliburEvent stream into the LIVING RAIL and render it as text without
 * bundling the whole Ink runtime. The Ink `<PhaseTimeline>` lives separately and
 * is only pulled in by the interactive TTY shell.
 */
export { reduceRail, type ReduceRailOptions } from './rail-reducer.js';
export { renderRail, type RenderRailOptions } from './rail-render.js';
export {
  renderRibbon,
  missionStatusChar,
  missionStatusHex,
  type RenderRibbonOptions,
  type MissionRibbonModel,
  type MissionStepView,
  type MissionStepStatus,
  type MissionRibbonOutcome,
} from './mission-ribbon.js';
export {
  renderPlanRibbon,
  planStatusChar,
  planStatusHex,
  type RenderPlanRibbonOptions,
  type PlanRibbonModel,
  type PlanRibbonPhaseView,
  type PlanRibbonStepView,
  type PlanRibbonStepStatus,
  type PlanRibbonOutcome,
} from './plan-ribbon.js';
export { renderTodos, type RenderTodosOptions } from './rail-todos.js';
export type { TodoItem } from './rail-types.js';
export {
  renderPlanCard,
  type PlanCardModel,
  type PlanPhase,
  type RenderPlanCardOptions,
} from './rail-plan.js';
export { detectColorTier, mix, paint, paintBg, stripAnsi, type ColorTier } from './color.js';
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
export { renderChronogram, type RenderChronogramOptions } from './chronogram-render.js';
export {
  detectThemeSync,
  formatCents,
  formatTokens,
  getColors,
  paletteFor,
  applyCustomColors,
  pulseColor,
  pulseGlyph,
  gaugeCells,
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
