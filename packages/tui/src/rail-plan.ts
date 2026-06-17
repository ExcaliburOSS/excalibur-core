import { paint, type ColorTier } from './color.js';
import { getColors, glyph, type Palette, type ThemeMode } from './theme.js';

/**
 * The PLAN card (build STEP 5) — a bordered, *gated* node rendered BEFORE a run
 * in the same visual language as the LIVING RAIL. Where Claude Code drops a plan
 * as markdown that scrolls away and OpenCode shows a near-invisible colour
 * change, our plan is a distinct box: the workflow + autonomy header, each phase
 * as a pending (○) node with its type and an optional/required marker, the swarm
 * sizing line when the allocator sizes to more than one agent, and a gate line
 * spelling out the keys. It is pure + snapshot-testable; colour is opt-in and
 * byte-identical to plain when omitted.
 */

export interface PlanPhase {
  name: string;
  type: string;
  optional?: boolean;
}

export interface PlanCardModel {
  workflowName: string;
  workflowId: string;
  autonomyLabel: string;
  phases: PlanPhase[];
  /** The allocator's explanation, shown only when it sizes to >1 agent. */
  swarmReason?: string;
  /** Pre-flight forecast line, e.g. "~$0.02 · ~45s · 2 files (from 6 runs)". */
  estimate?: string;
  /** Sensitive areas the run touches (rendered as a warn line). */
  sensitiveAreas?: string[];
  /** The gate hint, e.g. "[Enter] run · [m] mode · [c] cancel". */
  gate: string;
}

export interface RenderPlanCardOptions {
  tier?: ColorTier;
  mode?: ThemeMode;
  /** Inner width of the box in columns (default 52). */
  width?: number;
}

const NAME_WIDTH = 16;

/** Renders the plan card to text lines (a bordered, gated node). */
export function renderPlanCard(model: PlanCardModel, options: RenderPlanCardOptions = {}): string[] {
  const tier: ColorTier = options.tier ?? 'none';
  const palette: Palette = getColors(options.mode ?? 'dark');
  const width = options.width ?? 52;
  const c = (text: string, hex: string): string =>
    tier === 'none' ? text : paint(text, hex, tier);

  // An inner content row: the left vertical rail is dim, the content painted by
  // the caller.
  const row = (inner: string): string => ` ${c(glyph.railV, palette.rail)} ${inner}`;

  const lines: string[] = [];

  // Header: ┌─ <workflow> ───── (workflow name in normal text, rule dim).
  const headerLabel = `${model.workflowName} `;
  const fill = glyph.boxH.repeat(Math.max(1, width - headerLabel.length - 1));
  lines.push(
    ` ${c(`${glyph.boxTL}${glyph.boxH} `, palette.rail)}${c(headerLabel, palette.text)}${c(
      fill,
      palette.rail,
    )}`,
  );
  lines.push(row(c(`${model.autonomyLabel} · ${model.workflowId}`, palette.muted)));

  // Phases as pending nodes.
  for (const phase of model.phases) {
    const optional = phase.optional === true ? c('  (optional)', palette.muted) : '';
    const name = c(phase.name.padEnd(NAME_WIDTH), palette.text);
    const type = c(phase.type, palette.muted);
    lines.push(row(`${c(glyph.pending, palette.muted)} ${name}${type}${optional}`));
  }

  if (model.estimate !== undefined && model.estimate.length > 0) {
    lines.push(row(c(`estimate · ${model.estimate}`, palette.muted)));
  }
  if (model.swarmReason !== undefined && model.swarmReason.length > 0) {
    lines.push(row(c(`swarm · ${model.swarmReason}`, palette.accent)));
  }
  if (model.sensitiveAreas !== undefined && model.sensitiveAreas.length > 0) {
    lines.push(row(c(`sensitive · ${model.sensitiveAreas.join(', ')}`, palette.warn)));
  }

  // Gate line + bottom border.
  lines.push(row(`${c(glyph.waiting, palette.warn)} ${c(model.gate, palette.text)}`));
  lines.push(` ${c(`${glyph.boxBL}${glyph.boxH.repeat(width)}`, palette.rail)}`);
  return lines;
}
