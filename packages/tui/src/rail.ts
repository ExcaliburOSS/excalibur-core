/**
 * The PURE rail entry of `@excalibur/tui` — `reduceRail` + `renderRail` + the
 * rail types, with NO Ink/React imports, so the CLI (and any consumer) can fold
 * an ExcaliburEvent stream into the LIVING RAIL and render it as text without
 * bundling the whole Ink runtime. The Ink `<PhaseTimeline>` lives separately and
 * is only pulled in by the interactive TTY shell.
 */
export { reduceRail, type ReduceRailOptions } from './rail-reducer.js';
export { renderRail, type RenderRailOptions } from './rail-render.js';
export type {
  ApprovalPrompt,
  Phase,
  PhaseEvent,
  PhaseState,
  RailModel,
  RunStatus,
} from './rail-types.js';
