import { paint, type ColorTier } from './color.js';
import {
  ascii,
  eventGlyph,
  formatCents,
  formatElapsed,
  getColors,
  glyph,
  spinnerFrames,
  type Palette,
  type ThemeMode,
} from './theme.js';
import type { Phase, PhaseEvent, RailModel } from './rail-types.js';

/**
 * Pure text rendering of the LIVING RAIL — the NO_COLOR / CI / non-TTY fallback
 * AND the snapshot-testable form of what the Ink `<PhaseTimeline>` draws.
 * Renders a {@link RailModel} (from `reduceRail`) as lines: a state-glyphed node
 * per phase, the ACTIVE phase's event stream nested under a rail connector, an
 * approval node when waiting, and a pinned status line. Degrades to ASCII glyphs
 * under `EXCALIBUR_ASCII=1`.
 *
 * Colour is OPT-IN: pass `tier` (+ optional `mode`) and the glyphs/tones/rail
 * are painted with the Excalibur palette, downsampled to the terminal's real
 * capability (see `color.ts`). With no `tier` the output is byte-identical to
 * the plain form, so snapshot tests and CI logs stay stable.
 */

const RAIL = ascii ? '|' : '│';
const NAME_WIDTH = 18;

/** Maps a phase state to its palette colour. */
function stateHex(state: Phase['state'], palette: Palette): string {
  switch (state) {
    case 'completed':
      return palette.success;
    case 'running':
      return palette.accent;
    case 'waiting':
      return palette.warn;
    case 'failed':
      return palette.danger;
    default:
      return palette.muted;
  }
}

/** Maps a within-phase event tone to its palette colour. */
function toneHex(tone: PhaseEvent['tone'], palette: Palette): string {
  switch (tone) {
    case 'accent':
      return palette.accent;
    case 'success':
      return palette.success;
    case 'warn':
      return palette.warn;
    default:
      return palette.muted;
  }
}

function stateChar(phase: Phase, spinnerFrame: number): string {
  switch (phase.state) {
    case 'completed':
      return glyph.done;
    case 'running':
      return spinnerFrames[spinnerFrame % spinnerFrames.length] ?? glyph.running;
    case 'waiting':
      return glyph.waiting;
    case 'failed':
      return glyph.failed;
    default:
      return glyph.pending;
  }
}

/** Index of the last running/waiting phase (the one whose events are expanded). */
function activeIndex(phases: ReadonlyArray<Phase>): number {
  for (let i = phases.length - 1; i >= 0; i -= 1) {
    if (phases[i]!.state === 'running' || phases[i]!.state === 'waiting') {
      return i;
    }
  }
  return -1;
}

export interface RenderRailOptions {
  /** Spinner animation frame for the running node. */
  spinnerFrame?: number;
  /**
   * Colour capability. Omit (or `'none'`) for the plain, byte-identical form;
   * pass a real tier to paint glyphs/tones/rail with the Excalibur palette.
   */
  tier?: ColorTier;
  /** Light/dark palette selection (defaults to dark). */
  mode?: ThemeMode;
}

/** Renders the rail model to an array of text lines. */
export function renderRail(model: RailModel, options: RenderRailOptions = {}): string[] {
  const frame = options.spinnerFrame ?? 0;
  const active = activeIndex(model.phases);
  const tier: ColorTier = options.tier ?? 'none';
  const palette = getColors(options.mode ?? 'dark');
  // `c(text, hex)` paints only when colour is on; otherwise returns text as-is,
  // keeping the no-colour output byte-identical to the plain renderer.
  const c = (text: string, hex: string): string => (tier === 'none' ? text : paint(text, hex, tier));
  const lines: string[] = [];

  model.phases.forEach((phase, index) => {
    const detail = phase.detail !== undefined && phase.detail.length > 0 ? `  ${phase.detail}` : '';
    const isActive = index === active;
    const glyphCol = c(stateChar(phase, frame), stateHex(phase.state, palette));
    // One accent, lots of dim: the active phase name reads in normal text, the
    // rest dim back so the live node pops. Pad only when a detail column follows
    // (otherwise trailing padding would be trapped inside the colour wrap and
    // survive trimEnd — keeping the stripped form identical to the plain one).
    const paddedName = detail.length > 0 ? phase.name.padEnd(NAME_WIDTH) : phase.name;
    const name = c(paddedName, isActive ? palette.text : palette.muted);
    const detailCol = detail.length > 0 ? c(detail, palette.muted) : '';
    lines.push(` ${glyphCol} ${name}${detailCol}`.trimEnd());
    // Only the active phase expands its event stream; completed ones collapse.
    if (isActive) {
      for (const event of phase.events ?? []) {
        const note = event.note !== undefined && event.note.length > 0 ? `  ${event.note}` : '';
        const hex = toneHex(event.tone, palette);
        const prefix = event.kind !== undefined ? `${c(eventGlyph[event.kind], hex)} ` : '';
        const text = c(event.text, hex);
        const noteCol = note.length > 0 ? c(note, palette.muted) : '';
        lines.push(` ${c(RAIL, palette.rail)}   ${prefix}${text}${noteCol}`.trimEnd());
      }
    }
  });

  if (model.approval !== undefined) {
    lines.push(
      ` ${c(glyph.waiting, palette.warn)} ${c(model.approval.question, palette.text)}   ${c(
        model.approval.options,
        palette.muted,
      )}`,
    );
  }

  // Pinned status line.
  const s = model.status;
  const autonomy = model.autonomyLabel.length > 0 ? `${c(model.autonomyLabel, palette.accent)} · ` : '';
  lines.push(` ${c('─'.repeat(48), palette.rail)}`);
  lines.push(
    `  ${autonomy}${c(s.safety, palette.muted)} · ${c(formatCents(s.costCents), palette.muted)} · ${c(
      formatElapsed(s.elapsedMs),
      palette.muted,
    )} · ${c(s.push ? 'push' : 'no push', palette.muted)} · ${c(s.model, palette.accent)}`,
  );
  return lines;
}
