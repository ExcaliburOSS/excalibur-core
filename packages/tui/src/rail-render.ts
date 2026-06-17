import { paint, type ColorTier } from './color.js';
import {
  ascii,
  eventGlyph,
  formatCents,
  formatElapsed,
  formatTokens,
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
  /**
   * Expand EVERY phase's event stream, not just the active one. Used by the
   * inspect/replay surface (`excalibur logs`) where there is no live "active"
   * phase and the reader wants the full structured history.
   */
  expandAll?: boolean;
  /**
   * Localized status words (i18n). English defaults keep the golden snapshots +
   * the pure form byte-identical; the CLI passes translated labels.
   */
  labels?: { push?: string; noPush?: string; tasks?: string };
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
    // The trailing annotation: detail, then per-phase duration + cost (the DX
    // battery — neither CC nor OpenCode shows per-phase timing/cost). Cost is
    // shown only when it rounds to ≥ 1¢ so sub-cent phases stay quiet.
    const parts: string[] = [];
    if (phase.detail !== undefined && phase.detail.length > 0) parts.push(phase.detail);
    if (phase.durationMs !== undefined) parts.push(formatElapsed(phase.durationMs));
    if (phase.costCents !== undefined && phase.costCents >= 0.5) {
      parts.push(formatCents(phase.costCents));
    }
    const annotation = parts.length > 0 ? `  ${parts.join(' · ')}` : '';
    const isActive = index === active;
    const glyphCol = c(stateChar(phase, frame), stateHex(phase.state, palette));
    // One accent, lots of dim: the active phase name reads in normal text, the
    // rest dim back so the live node pops. Pad only when an annotation follows
    // (otherwise trailing padding would be trapped inside the colour wrap and
    // survive trimEnd — keeping the stripped form identical to the plain one).
    const paddedName = annotation.length > 0 ? phase.name.padEnd(NAME_WIDTH) : phase.name;
    const name = c(paddedName, isActive ? palette.text : palette.muted);
    const detailCol = annotation.length > 0 ? c(annotation, palette.muted) : '';
    lines.push(` ${glyphCol} ${name}${detailCol}`.trimEnd());
    // The active phase expands its event stream; completed ones collapse —
    // unless `expandAll` (the inspect/replay surface wants the full history).
    if (isActive || options.expandAll === true) {
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

  // The in-session checklist (the `task_update` band). One line per item with a
  // state glyph; the active item reads in the accent, done items dim with a ✓,
  // pending stay muted. A header shows the done/total count. Unlike Claude
  // Code's ephemeral TodoWrite, this is folded from the event stream — so it is
  // replayable and shows identically in `logs`.
  if (model.todos !== undefined && model.todos.length > 0) {
    const total = model.todos.length;
    const doneCount = model.todos.filter((todo) => todo.status === 'completed').length;
    lines.push(
      ` ${c(glyph.logo, palette.accent)} ${c(options.labels?.tasks ?? 'Tasks', palette.text)}  ${c(
        `${doneCount}/${total}`,
        palette.muted,
      )}`,
    );
    for (const todo of model.todos) {
      const g =
        todo.status === 'completed'
          ? { ch: glyph.done, hex: palette.success }
          : todo.status === 'in_progress'
            ? { ch: glyph.running, hex: palette.accent }
            : { ch: glyph.pending, hex: palette.muted };
      const textHex =
        todo.status === 'in_progress'
          ? palette.text
          : todo.status === 'completed'
            ? palette.muted
            : palette.muted;
      lines.push(` ${c(RAIL, palette.rail)}   ${c(g.ch, g.hex)} ${c(todo.text, textHex)}`.trimEnd());
    }
  }

  if (model.approval !== undefined) {
    lines.push(
      ` ${c(glyph.waiting, palette.warn)} ${c(model.approval.question, palette.text)}   ${c(
        model.approval.options,
        palette.muted,
      )}`,
    );
  }

  // Pinned status line: autonomy · safety · cost · [tokens] · elapsed · push ·
  // model. Tokens (in↑/out↓) appear only once the run has made a model call.
  const s = model.status;
  const autonomy = model.autonomyLabel.length > 0 ? `${c(model.autonomyLabel, palette.accent)} · ` : '';
  const tokens =
    s.inputTokens + s.outputTokens > 0
      ? `${c(`${formatTokens(s.inputTokens)}↑ ${formatTokens(s.outputTokens)}↓`, palette.muted)} · `
      : '';
  lines.push(` ${c('─'.repeat(48), palette.rail)}`);
  lines.push(
    `  ${autonomy}${c(s.safety, palette.muted)} · ${c(formatCents(s.costCents), palette.muted)} · ${tokens}${c(
      formatElapsed(s.elapsedMs),
      palette.muted,
    )} · ${c(s.push ? (options.labels?.push ?? 'push') : (options.labels?.noPush ?? 'no push'), palette.muted)} · ${c(s.model, palette.accent)}`,
  );
  return lines;
}
