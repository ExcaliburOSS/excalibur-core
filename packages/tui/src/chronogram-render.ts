import { paint, type ColorTier } from './color.js';
import type { ChronogramDto, ChronogramLaneDto, ChronogramLaneState } from '@excalibur/shared';
import {
  eventGlyph,
  formatCents,
  formatElapsed,
  getColors,
  glyph,
  type Palette,
  type ThemeMode,
} from './theme.js';

/**
 * AO6 Pillar 2 — the orchestration CHRONOGRAM renderer (TTY). Draws a swarm's
 * {@link ChronogramDto} as a wave/DAG timeline: a header, then per dependency
 * WAVE a labelled group of lane rows (state glyph · title · a proportional
 * duration bar · elapsed/cost · dependency hint), and a fan-in summary footer.
 * Pure + snapshot-testable; colour is opt-in and byte-identical to plain, and
 * the SAME DTO feeds the dashboard timeline — `reduceRail` discipline.
 */

export interface RenderChronogramOptions {
  tier?: ColorTier;
  mode?: ThemeMode;
  /** Explicit palette (a named theme preset); wins over `mode` when provided. */
  palette?: Palette;
  /** Lane title column width (default 24). */
  titleWidth?: number;
  /** Duration-bar width in cells (default 14). */
  barWidth?: number;
  /** Wall-clock now (ms) → live elapsed for still-running lanes. */
  nowMs?: number;
  /** Localized words (i18n); English defaults keep snapshots byte-identical. */
  labels?: {
    chronogram?: string;
    wave?: string;
    done?: string;
    running?: string;
    failed?: string;
    pending?: string;
    depends?: string;
    paused?: string;
  };
}

function laneGlyphHex(state: ChronogramLaneState, palette: Palette): { g: string; hex: string } {
  switch (state) {
    case 'done':
      return { g: glyph.done, hex: palette.success };
    case 'failed':
      return { g: glyph.failed, hex: palette.danger };
    case 'running':
      return { g: glyph.running, hex: palette.accent };
    case 'cancelled':
      return { g: glyph.failed, hex: palette.muted };
    case 'empty':
      return { g: glyph.done, hex: palette.muted };
    default:
      return { g: glyph.pending, hex: palette.muted };
  }
}

/** This lane's display duration: the finished span, or live elapsed for a runner. */
function laneDurationMs(lane: ChronogramLaneDto, nowMs: number | undefined): number | null {
  if (lane.durationMs !== null) return lane.durationMs;
  if (lane.state === 'running' && lane.startedAt !== null && nowMs !== undefined) {
    const started = Date.parse(lane.startedAt);
    return Number.isNaN(started) ? null : Math.max(0, nowMs - started);
  }
  return null;
}

/** A proportional █/░ bar; an active runner with no span yet shows a single tick. */
function durationBar(
  ms: number | null,
  maxMs: number,
  width: number,
  state: ChronogramLaneState,
): string {
  if (ms === null || maxMs <= 0) {
    return state === 'running' ? '▕'.padEnd(width, '░') : '░'.repeat(width);
  }
  const filled = Math.max(1, Math.min(width, Math.round((ms / maxMs) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Renders the chronogram to text lines. */
export function renderChronogram(
  model: ChronogramDto,
  options: RenderChronogramOptions = {},
): string[] {
  const tier: ColorTier = options.tier ?? 'none';
  const palette = options.palette ?? getColors(options.mode ?? 'dark');
  const titleWidth = options.titleWidth ?? 24;
  const barWidth = options.barWidth ?? 14;
  const c = (text: string, hex: string): string =>
    tier === 'none' ? text : paint(text, hex, tier);
  const L = options.labels ?? {};
  const chronogramWord = L.chronogram ?? 'Chronogram';
  const waveWord = L.wave ?? 'Wave';
  const dependsWord = L.depends ?? 'depends';

  const laneById = new Map(model.lanes.map((l) => [l.id, l]));
  const durations = new Map<string, number | null>();
  for (const lane of model.lanes) durations.set(lane.id, laneDurationMs(lane, options.nowMs));
  const maxMs = Math.max(
    0,
    ...[...durations.values()].filter((d): d is number => typeof d === 'number'),
  );

  const lines: string[] = [];

  // Header: task · mode · status · total cost · elapsed span.
  const headParts = [model.task, model.mode, model.paused ? (L.paused ?? 'paused') : model.status];
  if (model.totalCostCents !== null && model.totalCostCents > 0) {
    headParts.push(formatCents(model.totalCostCents));
  }
  if (model.completedAt !== null) {
    const span = Date.parse(model.completedAt) - Date.parse(model.startedAt);
    if (!Number.isNaN(span)) headParts.push(formatElapsed(Math.max(0, span)));
  }
  lines.push(
    ` ${c(eventGlyph.branch, palette.accent)} ${c(`${chronogramWord} · ${headParts.join(' · ')}`, palette.text)}`,
  );

  // One labelled group per wave, lanes drawn as timeline bars.
  model.waves.forEach((waveIds, waveIndex) => {
    lines.push(`   ${c(`${waveWord} ${waveIndex + 1}`, palette.muted)}`);
    waveIds.forEach((id, laneIndex) => {
      const lane = laneById.get(id);
      if (lane === undefined) return;
      const isLast = laneIndex === waveIds.length - 1;
      const connector = c(isLast ? glyph.branch : glyph.branchMid, palette.rail);
      const { g, hex } = laneGlyphHex(lane.state, palette);
      const title = c(lane.title.slice(0, titleWidth).padEnd(titleWidth), palette.text);
      const ms = durations.get(id) ?? null;
      const bar = c(durationBar(ms, maxMs, barWidth, lane.state), hex);

      const stats: string[] = [];
      if (ms !== null) stats.push(formatElapsed(ms));
      if (lane.costCents !== null && lane.costCents > 0) stats.push(formatCents(lane.costCents));
      const statsCol = stats.length > 0 ? c(stats.join(' · '), palette.muted) : '';
      const deps = lane.dependsOn
        .map((d) => laneById.get(d)?.title ?? d)
        .filter((t) => t.length > 0);
      const depCol =
        deps.length > 0
          ? `  ${c(`${glyph.diffExpand} ${dependsWord}: ${deps.join(', ')}`, palette.muted)}`
          : '';
      lines.push(` ${connector} ${c(g, hex)} ${title} ${bar} ${statsCol}${depCol}`.trimEnd());
    });
  });

  // Fan-in summary: done/running/failed tallies + the merge node.
  const tally = (s: ChronogramLaneState): number => model.lanes.filter((l) => l.state === s).length;
  const done = tally('done');
  const running = tally('running');
  const failed = tally('failed');
  const summary = [`${done} ${L.done ?? 'done'}`];
  if (running > 0) summary.push(`${running} ${L.running ?? 'running'}`);
  if (failed > 0) summary.push(`${failed} ${L.failed ?? 'failed'}`);
  const pending = tally('pending');
  if (pending > 0) summary.push(`${pending} ${L.pending ?? 'pending'}`);
  lines.push(
    ` ${c(eventGlyph.tool, palette.accent)} ${c(summary.join(' · '), failed > 0 ? palette.warn : palette.muted)}`,
  );
  return lines;
}
