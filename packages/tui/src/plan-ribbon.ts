import { paint, type ColorTier } from './color.js';
import { ascii, getColors, glyph, spinnerFrames, type Palette, type ThemeMode } from './theme.js';

/**
 * PLAN4 — the LIVE PLAN RIBBON: a structured plan ({@link StructuredPlan} in core)
 * rendered ABOVE the run rail while it executes step by step (PLAN3). It shows the
 * whole plan as a phase→step tree with each step's live status (✓ done · ◐ active ·
 * ○ pending · ✗ blocked · ⊘ skipped), so the user always sees WHERE in the plan the
 * agent is and what is left — the terminal twin of the dashboard plan tree.
 *
 * Pure + total (no Ink, no I/O): the same model drives the live Ink `<PlanRibbon>`
 * and this string twin, so live == replay == non-TTY, exactly like the mission
 * ribbon and the rail. The CLI projects the in-place-mutated structured plan into a
 * {@link PlanRibbonModel} on every step transition and pins it via `setPlanRibbon`.
 */

/** Mirrors core's `PlanStepStatus` (no mapping needed — the ribbon is plan-native). */
export type PlanRibbonStepStatus = 'pending' | 'active' | 'done' | 'blocked' | 'skipped';

/** One leaf of the tree — a plan step with its live status. */
export interface PlanRibbonStepView {
  id: string;
  title: string;
  status: PlanRibbonStepStatus;
}

/** A phase groups steps (the level the mission ribbon's flat DAG doesn't have). */
export interface PlanRibbonPhaseView {
  id: string;
  title: string;
  steps: PlanRibbonStepView[];
}

export type PlanRibbonOutcome = 'executing' | 'completed' | 'paused' | 'blocked';

export interface PlanRibbonModel {
  task: string;
  phases: PlanRibbonPhaseView[];
  /** Steps done so far (drives the header `done/total` annotation). */
  done: number;
  total: number;
  outcome?: PlanRibbonOutcome;
}

const SKIPPED_GLYPH = ascii ? '-' : '⊘';
const DIAMOND = ascii ? '#' : '◆';

/** The palette colour for a step status (shared by the string + Ink renderers). */
export function planStatusHex(status: PlanRibbonStepStatus, palette: Palette): string {
  switch (status) {
    case 'done':
      return palette.success;
    case 'active':
      return palette.accent;
    case 'blocked':
      return palette.danger;
    case 'skipped':
      return palette.muted;
    default:
      return palette.muted;
  }
}

/** The glyph for a step status (the active node animates with the spinner). */
export function planStatusChar(status: PlanRibbonStepStatus, spinnerFrame: number): string {
  switch (status) {
    case 'done':
      return glyph.done;
    case 'active':
      return spinnerFrames[spinnerFrame % spinnerFrames.length] ?? glyph.running;
    case 'blocked':
      return glyph.failed;
    case 'skipped':
      return SKIPPED_GLYPH;
    default:
      return glyph.pending;
  }
}

export interface RenderPlanRibbonOptions {
  spinnerFrame?: number;
  /** Pass a real tier to paint the ribbon with the Excalibur palette (opt-in). */
  tier?: ColorTier;
  mode?: ThemeMode;
  palette?: Palette;
  /** Terminal columns, to trim long titles (default 80). */
  width?: number;
}

/**
 * Renders the plan ribbon as lines (header + a phase title line then a connector
 * row per step). Colour is opt-in via `tier`; with no tier the output is plain
 * (byte-identical → snapshot-stable), exactly like the rail/mission renderers.
 */
export function renderPlanRibbon(
  model: PlanRibbonModel,
  options: RenderPlanRibbonOptions = {},
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
      : model.outcome === 'blocked'
        ? palette.danger
        : model.outcome === 'paused'
          ? palette.warn
          : palette.accent;
  const annotation = model.total > 0 ? `  ${model.done}/${model.total}` : '';
  const taskMax = Math.max(16, width - 9 - annotation.length);
  const task = model.task.length > taskMax ? `${model.task.slice(0, taskMax - 1)}…` : model.task;
  const lines: string[] = [
    `${c(DIAMOND, outcomeHex)} ${c('Plan:', palette.text)} ${c(task, palette.text)}${annotation.length > 0 ? c(annotation, palette.muted) : ''}`.trimEnd(),
  ];

  for (const phase of model.phases) {
    if (phase.title.length > 0) {
      const phaseMax = Math.max(10, width - 4);
      const phaseText =
        phase.title.length > phaseMax ? `${phase.title.slice(0, phaseMax - 1)}…` : phase.title;
      lines.push(`  ${c(phaseText, palette.text)}`.trimEnd());
    }
    phase.steps.forEach((step, index) => {
      const last = index === phase.steps.length - 1;
      const connector = last ? glyph.branch : glyph.branchMid;
      const hex = planStatusHex(step.status, palette);
      const ch = planStatusChar(step.status, frame);
      const titleMax = Math.max(10, width - 8);
      const title =
        step.title.length > titleMax ? `${step.title.slice(0, titleMax - 1)}…` : step.title;
      lines.push(` ${c(connector, palette.rail)} ${c(ch, hex)} ${c(title, hex)}`.trimEnd());
    });
  }

  return lines;
}
