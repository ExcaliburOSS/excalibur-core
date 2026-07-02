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

/**
 * The LIVE shell palette. Seeded synchronously (EXCALIBUR_THEME / COLORFGBG →
 * dark fallback) so early chrome still paints; {@link initShellTheme} re-resolves
 * it once real detection lands (config `ui.theme` / the OSC-11 terminal query) —
 * D11: light-background terminals used to keep the DARK palette forever because
 * the async query existed but nothing outside the demo ever called it. Mutated
 * IN PLACE so every module that imported the reference stays current.
 */
export const shellPalette: Palette = { ...getColors(detectThemeSync() ?? 'dark') };
export const shellTier: ColorTier = tier;

/**
 * D11 — swap the live palette (same object, new values). Call ONCE at session
 * start with the properly-resolved palette (`paletteFor(config.ui?.theme ??
 * 'auto', await resolveThemeMode())` + custom colours). Idempotent.
 */
export function initShellTheme(next: Palette): void {
  Object.assign(shellPalette, next);
}

function brand(text: string, hex: string, ansi16: (s: string) => string): string {
  if (tier === 'none') return text;
  if (tier === 'truecolor' || tier === 'ansi256') return paint(text, hex, tier);
  return ansi16(text);
}

/** Primary sword-blue accent — the prompt arrow, spinner, live marks. */
export const accent = (text: string): string => brand(text, shellPalette.accent, pc.blueBright);
/** Glow accent — emphasis / the pulse crest. */
export const accentBright = (text: string): string =>
  brand(text, shellPalette.accentBright, pc.cyanBright);
/** Subdued accent — secondary chrome, hints, connectors. */
export const accentDim = (text: string): string => brand(text, shellPalette.accentDim, pc.blue);

/**
 * D10 — the SEMANTIC tones (teal ok / coral bad / amber warn) with clean 16-colour
 * fallbacks, so plain-string chrome (the receipt, selects) paints through the SAME
 * palette the rail uses instead of raw ANSI green/red/yellow that never matched.
 */
export const tone = {
  ok: (text: string): string => brand(text, shellPalette.success, pc.green),
  bad: (text: string): string => brand(text, shellPalette.danger, pc.red),
  warn: (text: string): string => brand(text, shellPalette.warn, pc.yellow),
};

/**
 * Paint the terminal's native block cursor in the sword-blue accent via OSC 12,
 * so the thing you type against glows the brand colour (modern terminals honour
 * it; older ones ignore the sequence). No-op when colour is off. ALWAYS pair
 * with {@link resetCursorColor} on exit so the user's cursor is restored.
 */
export function setCursorAccent(stream: NodeJS.WritableStream): void {
  if (tier === 'none') return;
  stream.write(`\x1b]12;${shellPalette.accent}\x07`);
}

/** Restore the terminal's cursor colour to its default (OSC 112). */
export function resetCursorColor(stream: NodeJS.WritableStream): void {
  if (tier === 'none') return;
  stream.write('\x1b]112\x07');
}
