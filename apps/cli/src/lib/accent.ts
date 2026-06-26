import pc from 'picocolors';
import {
  detectColorTier,
  detectThemeSync,
  getColors,
  paint,
  type ColorTier,
  type Palette,
} from '@excalibur/tui';

/**
 * The shell's single source of "sword blue".
 *
 * Historically the picocolors layer (the prompt arrow, the spinner glyph, the
 * interactive questions, the select markers) reached for `pc.cyan` — a GREENISH
 * blue — in some places and `pc.blueBright` in others, so the TUI spoke two
 * different blues that never matched the rail's truecolor accent. This module
 * resolves the ONE canonical accent and degrades it cleanly:
 *
 *   truecolor / 256-colour → the exact palette hex (`#4DA3FF` dark, `#0969DA` light)
 *   16-colour              → the closest TRUE blue ANSI tone (never cyan)
 *   no colour              → plain text (honours NO_COLOR / non-TTY / `dumb`)
 *
 * It also follows the light/dark theme (via `EXCALIBUR_THEME` / `COLORFGBG`), so
 * the shell accent matches the canonical Cobalt palette the rail renders with.
 */
const tier: ColorTier = detectColorTier();
const palette: Palette = getColors(detectThemeSync() ?? 'dark');

function brand(text: string, hex: string, ansi16: (s: string) => string): string {
  if (tier === 'none') return text;
  if (tier === 'truecolor' || tier === 'ansi256') return paint(text, hex, tier);
  return ansi16(text);
}

/** Primary sword-blue accent — the prompt arrow, spinner, live marks. */
export const accent = (text: string): string => brand(text, palette.accent, pc.blueBright);
/** Glow accent — emphasis / the pulse crest. */
export const accentBright = (text: string): string =>
  brand(text, palette.accentBright, pc.cyanBright);
/** Subdued accent — secondary chrome, hints, connectors. */
export const accentDim = (text: string): string => brand(text, palette.accentDim, pc.blue);

/** The resolved palette + colour tier, for callers that paint directly. */
export const shellPalette: Palette = palette;
export const shellTier: ColorTier = tier;

/**
 * Paint the terminal's native block cursor in the sword-blue accent via OSC 12,
 * so the thing you type against glows the brand colour (modern terminals honour
 * it; older ones ignore the sequence). No-op when colour is off. ALWAYS pair
 * with {@link resetCursorColor} on exit so the user's cursor is restored.
 */
export function setCursorAccent(stream: NodeJS.WritableStream): void {
  if (tier === 'none') return;
  stream.write(`\x1b]12;${palette.accent}\x07`);
}

/** Restore the terminal's cursor colour to its default (OSC 112). */
export function resetCursorColor(stream: NodeJS.WritableStream): void {
  if (tier === 'none') return;
  stream.write('\x1b]112\x07');
}
