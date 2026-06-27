import { mix } from './color.js';
import type { Palette } from './theme.js';

/**
 * The "this is happening right now" pulse on the in-progress action line.
 *
 * Claude Code animates the active step by sweeping a soft highlight across its
 * text; we do the same. {@link shimmerSpans} splits a line into coloured spans
 * with a bright crest that travels left→right as the animation `frame` advances,
 * fading back to the resting colour over a few characters (a comet-trail). It is a
 * pure function of `frame` (no wall-clock), so it stays deterministic and
 * snapshot-testable, and it only changes COLOUR — joining the spans' text
 * reproduces the input exactly, so width and wrapping are untouched.
 */

export interface ShimmerSpan {
  text: string;
  hex: string;
}

/** Characters at/after the crest that stay lit (the width of the moving band). */
const BAND = 6;
/** Extra travel past the end of the line before the sweep restarts (a brief rest). */
const TAIL = 8;

/**
 * Splits `text` into contiguous coloured spans with a highlight that sweeps across
 * it as `frame` advances. `base` is the resting colour; the crest rides the
 * palette's bright accent. Returns `[]` for empty text. Adjacent same-colour runs
 * are coalesced, so a line yields only a handful of spans (not one per character).
 */
export function shimmerSpans(
  text: string,
  frame: number,
  palette: Palette,
  base: string,
): ShimmerSpan[] {
  // Code-point aware so a multi-byte glyph is never split mid-character.
  const chars = [...text];
  const n = chars.length;
  if (n === 0) {
    return [];
  }
  const period = n + TAIL;
  const head = ((Math.floor(frame) % period) + period) % period;
  const crest = palette.accentBright;

  const colourAt = (i: number): string => {
    const delta = head - i; // how far the crest has travelled past this char
    if (delta < 0 || delta >= BAND) {
      return base;
    }
    // delta 0 = full crest, fading linearly back to `base` at delta = BAND.
    return mix(base, crest, (BAND - delta) / BAND);
  };

  const spans: ShimmerSpan[] = [];
  let runHex = colourAt(0);
  let runText = chars[0]!;
  for (let i = 1; i < n; i += 1) {
    const hex = colourAt(i);
    if (hex === runHex) {
      runText += chars[i]!;
    } else {
      spans.push({ text: runText, hex: runHex });
      runHex = hex;
      runText = chars[i]!;
    }
  }
  spans.push({ text: runText, hex: runHex });
  return spans;
}
