import { ascii, formatCents, formatElapsed, glyph, spinnerFrames } from './theme.js';
import type { Phase, RailModel } from './rail-types.js';

/**
 * Pure text rendering of the LIVING RAIL (no Ink, no color) — the NO_COLOR / CI
 * / non-TTY fallback AND the snapshot-testable form of what the Ink
 * `<PhaseTimeline>` draws. Renders a {@link RailModel} (from `reduceRail`) as
 * lines: a state-glyphed node per phase, the ACTIVE phase's event stream nested
 * under a rail connector, an approval node when waiting, and a pinned status
 * line. Degrades to ASCII glyphs under `EXCALIBUR_ASCII=1`.
 */

const RAIL = ascii ? '|' : '│';
const NAME_WIDTH = 18;

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
}

/** Renders the rail model to an array of text lines. */
export function renderRail(model: RailModel, options: RenderRailOptions = {}): string[] {
  const frame = options.spinnerFrame ?? 0;
  const active = activeIndex(model.phases);
  const lines: string[] = [];

  model.phases.forEach((phase, index) => {
    const detail = phase.detail !== undefined && phase.detail.length > 0 ? `  ${phase.detail}` : '';
    lines.push(` ${stateChar(phase, frame)} ${phase.name.padEnd(NAME_WIDTH)}${detail}`.trimEnd());
    // Only the active phase expands its event stream; completed ones collapse.
    if (index === active) {
      for (const event of phase.events ?? []) {
        const note = event.note !== undefined && event.note.length > 0 ? `  ${event.note}` : '';
        lines.push(` ${RAIL}   ${event.text}${note}`.trimEnd());
      }
    }
  });

  if (model.approval !== undefined) {
    lines.push(` ${glyph.waiting} ${model.approval.question}   ${model.approval.options}`);
  }

  // Pinned status line.
  const s = model.status;
  const autonomy = model.autonomyLabel.length > 0 ? `${model.autonomyLabel} · ` : '';
  lines.push(` ${'─'.repeat(48)}`);
  lines.push(
    `  ${autonomy}${s.safety} · ${formatCents(s.costCents)} · ${formatElapsed(s.elapsedMs)} · ${
      s.push ? 'push' : 'no push'
    } · ${s.model}`,
  );
  return lines;
}
