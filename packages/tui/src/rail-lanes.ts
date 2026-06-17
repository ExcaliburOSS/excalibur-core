import { paint, type ColorTier } from './color.js';
import { formatDiffStat, type DiffStat } from './diff-stat.js';
import { eventGlyph, getColors, glyph, type Palette, type ThemeMode } from './theme.js';

/**
 * SWARM LANES (build STEP 9) — the visual payoff of the auto-sizing allocator.
 * Where Claude Code stacks agents one at a time and OpenCode pages through them
 * singly, the swarm fans out N implementers into isolated worktrees and we draw
 * them as concurrent sub-rails branching off a swarm node and converging on a
 * fan-in merge node: one line per lane with its state glyph, title, tool count,
 * diffstat and cost, then a merge footer with applied/conflict counts.
 *
 * Pure + snapshot-testable; colour is opt-in and byte-identical to plain.
 */

export type LaneState = 'done' | 'empty' | 'failed' | 'conflict' | 'running';

export interface LaneModel {
  id: string;
  title: string;
  state: LaneState;
  toolCalls?: number;
  diff?: DiffStat;
  costCents?: number | null;
  /** Failure/conflict detail, shown trailing in the lane's tone. */
  detail?: string;
}

export interface LanesModel {
  lanes: LaneModel[];
  /** Lanes whose diffs merged cleanly. */
  applied: number;
  /** Lanes dropped for conflicting on merge. */
  conflicts: number;
}

export interface RenderLanesOptions {
  tier?: ColorTier;
  mode?: ThemeMode;
  /** Lane title column width (default 22). */
  titleWidth?: number;
  /**
   * Localized header/footer words (i18n). English defaults keep the snapshots +
   * pure form byte-identical; the CLI passes translated labels.
   */
  labels?: { swarm?: string; lanes?: string; merge?: string; applied?: string; conflict?: string };
}

function laneGlyphHex(state: LaneState, palette: Palette): { g: string; hex: string } {
  switch (state) {
    case 'done':
      return { g: glyph.done, hex: palette.success };
    case 'failed':
      return { g: glyph.failed, hex: palette.danger };
    case 'conflict':
      return { g: glyph.waiting, hex: palette.warn };
    case 'running':
      return { g: glyph.running, hex: palette.accent };
    default:
      return { g: glyph.sub, hex: palette.muted };
  }
}

function formatCost(costCents: number | null | undefined): string {
  return typeof costCents === 'number' ? `$${(costCents / 100).toFixed(2)}` : '';
}

/** Renders the swarm lanes panel to text lines. */
export function renderLanes(model: LanesModel, options: RenderLanesOptions = {}): string[] {
  const tier: ColorTier = options.tier ?? 'none';
  const palette = getColors(options.mode ?? 'dark');
  const titleWidth = options.titleWidth ?? 22;
  const c = (text: string, hex: string): string =>
    tier === 'none' ? text : paint(text, hex, tier);
  const L = options.labels ?? {};
  const swarmWord = L.swarm ?? 'Swarm';
  const lanesWord = L.lanes ?? 'lanes';
  const mergeWord = L.merge ?? 'merge';
  const appliedWord = L.applied ?? 'applied';
  const conflictWord = L.conflict ?? 'conflict';

  const lines: string[] = [];
  lines.push(
    ` ${c(eventGlyph.branch, palette.accent)} ${c(`${swarmWord} · ${model.lanes.length} ${lanesWord}`, palette.text)}`,
  );

  model.lanes.forEach((lane, index) => {
    const isLast = index === model.lanes.length - 1;
    const connector = c(`${isLast ? glyph.branch : glyph.branchMid}${glyph.boxH}`, palette.rail);
    const lane0 = laneGlyphHex(lane.state, palette);
    const badge = c(glyph.logo, lane0.hex);
    const title = c(lane.title.padEnd(titleWidth), palette.text);

    const stats: string[] = [];
    if (typeof lane.toolCalls === 'number' && lane.toolCalls > 0) {
      stats.push(`${lane.toolCalls}t`);
    }
    if (lane.diff !== undefined) {
      const ds = formatDiffStat(lane.diff);
      if (ds.length > 0) stats.push(ds);
    }
    const cost = formatCost(lane.costCents);
    if (cost.length > 0) stats.push(cost);
    const statsCol = stats.length > 0 ? c(stats.join('  '), palette.muted) : '';
    const detail =
      lane.detail !== undefined && lane.detail.length > 0
        ? `  ${c(lane.detail, lane0.hex)}`
        : '';
    // A guaranteed space after the (padded) title column so stats never abut a
    // title that exactly fills the width.
    lines.push(` ${connector} ${badge} ${title} ${statsCol}${detail}`.trimEnd());
  });

  const conflictPart = model.conflicts > 0 ? ` · ${model.conflicts} ${conflictWord}` : '';
  lines.push(
    ` ${c(eventGlyph.tool, palette.accent)} ${c(
      `${mergeWord} · ${model.applied} ${appliedWord}${conflictPart}`,
      model.conflicts > 0 ? palette.warn : palette.muted,
    )}`,
  );
  return lines;
}
