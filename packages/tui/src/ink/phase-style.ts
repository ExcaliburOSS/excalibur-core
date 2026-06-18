import { glyph, spinnerFrames, type Palette } from '../theme.js';
import type { PhaseEvent, PhaseState } from '../rail-types.js';

/**
 * Phase-state → glyph + palette colour, and event-tone → palette colour. Shared
 * by the Ink components so the live TTY view picks the same glyphs/tones as the
 * pure `renderRail` string presenter (the two presenters of one `RailModel`).
 */
export function stateGlyph(
  state: PhaseState,
  spinnerFrame: number,
  colors: Palette,
): { char: string; color: string } {
  switch (state) {
    case 'completed':
      return { char: glyph.done, color: colors.success };
    case 'running':
      return {
        char: spinnerFrames[spinnerFrame % spinnerFrames.length] ?? glyph.running,
        color: colors.accent,
      };
    case 'waiting':
      return { char: glyph.waiting, color: colors.warn };
    case 'failed':
      return { char: glyph.failed, color: colors.danger };
    case 'pending':
    default:
      return { char: glyph.pending, color: colors.muted };
  }
}

export function toneColor(tone: PhaseEvent['tone'], colors: Palette): string {
  switch (tone) {
    case 'accent':
      return colors.accent;
    case 'success':
      return colors.success;
    case 'warn':
      return colors.warn;
    case 'muted':
    default:
      return colors.muted;
  }
}
