import { paint, type ColorTier } from './color.js';
import {
  ascii,
  formatCents,
  formatElapsed,
  getColors,
  glyph,
  spinnerFrames,
  type Palette,
  type ThemeMode,
} from './theme.js';

/**
 * M7 — the PLAN RIBBON: the meta-orchestrator's "mission layer" rendered ABOVE the
 * run rail. It shows the capability DAG the supervisor is driving as a live tree
 * (✓ done · ◐ running · ○ pending · ✗ failed · ⊘ skipped), so the user always sees
 * WHERE in the strategy the mission is — and the adaptive moments (a step retried,
 * escalated, or a replan) become visible. Pure + total (no Ink, no I/O): the same
 * model drives the live Ink `<MissionRibbon>` and this string twin, so live ==
 * replay == non-TTY, exactly like the rail. The supervisor already maintains the
 * full mission state, so the CLI projects it straight into a {@link MissionRibbonModel}
 * (no event-folding needed) and feeds it on every progress event.
 */

export type MissionStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** One node of the ribbon — a capability step with its live status. */
export interface MissionStepView {
  id: string;
  /** The capability kind (`understand`, `implement`, `parallelize`, …) as text. */
  capability: string;
  objective: string;
  status: MissionStepStatus;
  gate: boolean;
  /** >1 marks a step that was retried/escalated (shown with a ↻ marker). */
  attempts?: number;
}

export type MissionRibbonOutcome = 'pending' | 'completed' | 'failed' | 'aborted' | 'paused';

export interface MissionRibbonModel {
  goal: string;
  steps: MissionStepView[];
  /** Accumulated model spend (cents) — shown in the header when > 0. */
  spentCents?: number;
  /** Budget ceiling (cents) — shown as `spent/budget` when set. */
  budgetCents?: number;
  /** Success-criteria progress (met/total) — shown as `m/t` when total > 0. */
  criteriaMet?: number;
  criteriaTotal?: number;
  elapsedMs?: number;
  outcome?: MissionRibbonOutcome;
}

const SKIPPED_GLYPH = ascii ? '-' : '⊘';
const RETRY_GLYPH = ascii ? '~' : '↻';
const DIAMOND = ascii ? '#' : '◆';

/** The palette colour for a step status (shared by the string + Ink renderers). */
export function missionStatusHex(status: MissionStepStatus, palette: Palette): string {
  switch (status) {
    case 'done':
      return palette.success;
    case 'running':
      return palette.accent;
    case 'failed':
      return palette.danger;
    case 'skipped':
      return palette.muted;
    default:
      return palette.muted;
  }
}

/** The glyph for a step status (the running node animates with the spinner). */
export function missionStatusChar(status: MissionStepStatus, spinnerFrame: number): string {
  switch (status) {
    case 'done':
      return glyph.done;
    case 'running':
      return spinnerFrames[spinnerFrame % spinnerFrames.length] ?? glyph.running;
    case 'failed':
      return glyph.failed;
    case 'skipped':
      return SKIPPED_GLYPH;
    default:
      return glyph.pending;
  }
}

/** The header trailing annotation: cost[/budget] · criteria · elapsed. */
function headerAnnotation(model: MissionRibbonModel): string {
  const parts: string[] = [];
  if (model.spentCents !== undefined && model.spentCents > 0) {
    parts.push(
      model.budgetCents !== undefined && model.budgetCents > 0
        ? `${formatCents(model.spentCents)}/${formatCents(model.budgetCents)}`
        : formatCents(model.spentCents),
    );
  }
  if (model.criteriaTotal !== undefined && model.criteriaTotal > 0) {
    parts.push(`${model.criteriaMet ?? 0}/${model.criteriaTotal}`);
  }
  if (model.elapsedMs !== undefined && model.elapsedMs > 0) {
    parts.push(formatElapsed(model.elapsedMs));
  }
  return parts.length > 0 ? `  ${parts.join(' · ')}` : '';
}

export interface RenderRibbonOptions {
  spinnerFrame?: number;
  /** Pass a real tier to paint the ribbon with the Excalibur palette (opt-in). */
  tier?: ColorTier;
  mode?: ThemeMode;
  palette?: Palette;
  /** Terminal columns, to trim long objectives (default 80). */
  width?: number;
}

/**
 * Renders the ribbon as lines (header + one line per step). Colour is opt-in via
 * `tier`; with no tier the output is plain (byte-identical → snapshot-stable).
 */
export function renderRibbon(
  model: MissionRibbonModel,
  options: RenderRibbonOptions = {},
): string[] {
  const tier: ColorTier = options.tier ?? 'none';
  const palette = options.palette ?? getColors(options.mode ?? 'dark');
  const frame = options.spinnerFrame ?? 0;
  const width = options.width ?? 80;
  const c = (text: string, hex: string): string =>
    tier === 'none' ? text : paint(text, hex, tier);

  const outcomeHex =
    model.outcome === 'completed'
      ? palette.success
      : model.outcome === 'failed' || model.outcome === 'aborted'
        ? palette.danger
        : model.outcome === 'paused'
          ? palette.warn
          : palette.accent;
  const annotation = headerAnnotation(model);
  const goalMax = Math.max(16, width - 12 - annotation.length);
  const goal = model.goal.length > goalMax ? `${model.goal.slice(0, goalMax - 1)}…` : model.goal;
  const lines: string[] = [
    `${c(DIAMOND, outcomeHex)} ${c('Mission:', palette.text)} ${c(goal, palette.text)}${annotation.length > 0 ? c(annotation, palette.muted) : ''}`.trimEnd(),
  ];

  model.steps.forEach((step, index) => {
    const last = index === model.steps.length - 1;
    const connector = last ? glyph.branch : glyph.branchMid;
    const hex = missionStatusHex(step.status, palette);
    const ch = missionStatusChar(step.status, frame);
    const gate = step.gate ? c(' (gate)', palette.warn) : '';
    const retry = (step.attempts ?? 1) > 1 ? c(` ${RETRY_GLYPH}`, palette.warn) : '';
    const name = c(step.capability.padEnd(12), hex);
    const objMax = Math.max(10, width - 22);
    const objText =
      step.objective.length > objMax ? `${step.objective.slice(0, objMax - 1)}…` : step.objective;
    const obj = objText.length > 0 ? `  ${c(objText, palette.muted)}` : '';
    lines.push(
      ` ${c(connector, palette.rail)} ${c(ch, hex)} ${name}${gate}${retry}${obj}`.trimEnd(),
    );
  });

  return lines;
}
