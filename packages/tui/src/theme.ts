/**
 * Excalibur terminal design tokens + automatic light/dark adaptation.
 *
 * A deliberately small palette — one accent, semantic states, a muted tone so
 * the important thing pops. The active palette is chosen from the terminal's
 * actual background (so it stays readable on light AND dark themes); glyphs
 * degrade to ASCII when the terminal lacks a Nerd/Unicode font.
 */

export const ascii = process.env['EXCALIBUR_ASCII'] === '1';

export type ThemeMode = 'light' | 'dark';

export interface Palette {
  mode: ThemeMode;
  /** Primary brand accent — the electric "sword blue" (cursor, prompt, live glyphs). */
  accent: string;
  /** Subdued accent for chrome (hunk headers, connectors, secondary marks). */
  accentDim: string;
  /** Glow peak — the brightest accent stop (pulse crest, word-level diff highlight). */
  accentBright: string;
  /** Deepest accent — the sword-blade blue (pulse trough, active borders). */
  accentDeep: string;
  success: string;
  warn: string;
  danger: string;
  text: string;
  muted: string;
  rail: string;
  /** Diff line foregrounds + faint row backgrounds + the brighter word-level highlight. */
  diffAddFg: string;
  diffDelFg: string;
  diffAddBg: string;
  diffDelBg: string;
  diffAddWordBg: string;
  diffDelWordBg: string;
}

/**
 * "Cobalt" — Excalibur's canonical dark theme. A futuristic blue/grey identity:
 * a single electric sword-blue accent on a 3-stop rampa (deep → accent → bright)
 * so live elements can pulse and glow, blue-tinted cool greys, and semantic
 * states cooled toward the palette (teal "good", coral "bad", amber the lone warm
 * pop). Diffs stay legible (teal vs coral) but the word-level highlight glows
 * cobalt — the precise changed characters light up blue.
 */
export const darkColors: Palette = {
  mode: 'dark',
  accent: '#4DA3FF', // electric azure
  accentDim: '#2F6FB5', // subdued accent for chrome
  accentBright: '#7FD4FF', // glow peak
  accentDeep: '#2368D0', // sword-blade blue
  success: '#3DD6A8', // cool teal "good"
  warn: '#F2C94C', // the single warm pop
  danger: '#FF6B7A', // coral "bad"
  text: '#E6EDF3',
  muted: '#8B98AB', // blue-tinted cool grey
  rail: '#34415A', // blue-tinted connector lines
  // Cooled diff tints: teal/coral foregrounds + faint row bg; the word-level
  // highlight is COBALT (accentDeep family) so changed tokens glow blue.
  diffAddFg: '#3DD6A8',
  diffDelFg: '#FF7A8A',
  diffAddBg: '#10302A',
  diffDelBg: '#351A20',
  diffAddWordBg: '#1D4E82',
  diffDelWordBg: '#1D4E82',
};

/** Tuned for light backgrounds (dark text, deeper accents — GitHub-light-like). */
export const lightColors: Palette = {
  mode: 'light',
  accent: '#0969DA',
  accentDim: '#0a4b9c',
  accentBright: '#1F6FEB',
  accentDeep: '#0550AE',
  success: '#1A7F37',
  warn: '#9A6700',
  danger: '#CF222E',
  text: '#1F2328',
  muted: '#636C76',
  rail: '#D0D7DE',
  // GitHub-light-like diff tints.
  diffAddFg: '#1A7F37',
  diffDelFg: '#CF222E',
  diffAddBg: '#E6FFEC',
  diffDelBg: '#FFEBE9',
  diffAddWordBg: '#ABF2BC',
  diffDelWordBg: '#FFC1BC',
};

/**
 * Colorblind-safe (deuteranopia/protanopia) — diffs and states use BLUE vs
 * AMBER instead of green/red, which collide for ~8% of men. Parity with CC's
 * daltonized themes.
 */
export const daltonizedDark: Palette = {
  mode: 'dark',
  accent: '#5BC8FF',
  accentDim: '#3A7CA0',
  accentBright: '#9FE0FF',
  accentDeep: '#2E8FD0',
  success: '#56B4E9', // blue = "good/added" (not green)
  warn: '#E69F00',
  danger: '#E69F00', // amber = "bad/removed" (not red)
  text: '#E6EDF3',
  muted: '#8B949E',
  rail: '#3A4048',
  diffAddFg: '#9CD3F0',
  diffDelFg: '#F0C36D',
  diffAddBg: '#10293A',
  diffDelBg: '#3A2A10',
  diffAddWordBg: '#1C4E70',
  diffDelWordBg: '#6E4E16',
};

export const daltonizedLight: Palette = {
  mode: 'light',
  accent: '#0969DA',
  accentDim: '#0a4b9c',
  accentBright: '#1F6FEB',
  accentDeep: '#0550AE',
  success: '#0072B2',
  warn: '#B35900',
  danger: '#B35900',
  text: '#1F2328',
  muted: '#636C76',
  rail: '#D0D7DE',
  diffAddFg: '#0072B2',
  diffDelFg: '#B35900',
  diffAddBg: '#E1EFFA',
  diffDelBg: '#FBEEDD',
  diffAddWordBg: '#B6DBF2',
  diffDelWordBg: '#F2D9B0',
};

/** Maximum-contrast palette for low-vision / bright-room use. */
export const highContrastDark: Palette = {
  mode: 'dark',
  accent: '#00D7FF',
  accentDim: '#00AFD7',
  accentBright: '#5CF0FF',
  accentDeep: '#008CB0',
  success: '#00FF5F',
  warn: '#FFD700',
  danger: '#FF5F5F',
  text: '#FFFFFF',
  muted: '#C0C0C0',
  rail: '#6A6A6A',
  diffAddFg: '#00FF5F',
  diffDelFg: '#FF5F5F',
  diffAddBg: '#003A1A',
  diffDelBg: '#3A0000',
  diffAddWordBg: '#008F3F',
  diffDelWordBg: '#8F0000',
};

/** A user-selectable theme name; `auto` follows the terminal's light/dark. */
export type ThemeName = 'auto' | 'dark' | 'light' | 'daltonized' | 'high-contrast';

/** All selectable theme names (for a `/theme` picker + config validation). */
export const THEME_NAMES: readonly ThemeName[] = [
  'auto',
  'dark',
  'light',
  'daltonized',
  'high-contrast',
];

export function getColors(mode: ThemeMode): Palette {
  return mode === 'light' ? lightColors : darkColors;
}

/**
 * Resolves a named theme to a concrete palette. `auto`/`dark`/`light` map to the
 * base palettes (honouring the detected `mode` for `auto`); the named presets
 * pick their light/dark variant by `mode`. Unknown names fall back to `auto`.
 */
export function paletteFor(name: ThemeName, mode: ThemeMode): Palette {
  switch (name) {
    case 'dark':
      return darkColors;
    case 'light':
      return lightColors;
    case 'daltonized':
      return mode === 'light' ? daltonizedLight : daltonizedDark;
    case 'high-contrast':
      return highContrastDark; // single high-contrast variant (dark base)
    case 'auto':
    default:
      return getColors(mode);
  }
}

/**
 * Merges user color overrides (P1.13 `ui.customTheme`) OVER a base palette.
 * Only the provided keys win; `mode` always comes from the base. A `undefined`
 * overrides object (or one with no keys) returns the base unchanged. Ignores any
 * `undefined`/empty values so a partially-specified override never blanks a color.
 */
export function applyCustomColors(
  base: Palette,
  overrides?: Partial<Omit<Palette, 'mode'>>,
): Palette {
  if (overrides === undefined) {
    return base;
  }
  const result = { ...base } as unknown as Record<string, string>;
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && value.length > 0) {
      result[key] = value;
    }
  }
  return result as unknown as Palette;
}

type GlyphSet = {
  done: string;
  running: string;
  pending: string;
  waiting: string;
  failed: string;
  railV: string;
  branch: string;
  branchMid: string;
  sub: string;
  bar: string;
  barEmpty: string;
  logo: string;
  boxTL: string;
  boxTR: string;
  boxBL: string;
  boxBR: string;
  boxH: string;
  diffExpand: string;
  diffCollapse: string;
};

const unicode: GlyphSet = {
  done: '✓',
  running: '◐',
  pending: '○',
  waiting: '⚑',
  failed: '✗',
  railV: '│',
  branch: '└',
  branchMid: '├',
  sub: '·',
  bar: '█',
  barEmpty: '░',
  logo: '▌',
  boxTL: '┌',
  boxTR: '┐',
  boxBL: '└',
  boxBR: '┘',
  boxH: '─',
  diffExpand: '▸',
  diffCollapse: '▾',
};

const asciiSet: GlyphSet = {
  done: 'v',
  running: '*',
  pending: 'o',
  waiting: '!',
  failed: 'x',
  railV: '|',
  branch: '`-',
  branchMid: '|-',
  sub: '-',
  bar: '#',
  barEmpty: '.',
  logo: '|',
  boxTL: '+',
  boxTR: '+',
  boxBL: '+',
  boxBR: '+',
  boxH: '-',
  diffExpand: '>',
  diffCollapse: 'v',
};

export const glyph: GlyphSet = ascii ? asciiSet : unicode;

import type { PhaseEventKind } from './rail-types.js';

/** Per-tool glyphs for within-phase event lines (Nerd/Unicode set). */
const unicodeEventGlyph: Record<PhaseEventKind, string> = {
  tool: '◈',
  read: '▭',
  write: '✎',
  command: '❯',
  exit: '↳',
  test: '◆',
  patch: '±',
  branch: '⎇',
  compaction: '≡',
  verification: '⚖',
  claim: '⊨',
  diagnostics: '⚠',
  narration: '“', // unused (narration renders as glyph-less prose) — type completeness only
  error: '✗',
};

const asciiEventGlyph: Record<PhaseEventKind, string> = {
  tool: '*',
  read: '-',
  write: '~',
  command: '>',
  exit: '=',
  test: '+',
  patch: '%',
  branch: 'Y',
  compaction: '#',
  verification: '!',
  claim: '=',
  diagnostics: '!',
  narration: '"', // unused (narration renders as glyph-less prose) — type completeness only
  error: 'x',
};

/** The glyph for a within-phase event kind, degrading to ASCII when needed. */
export const eventGlyph: Record<PhaseEventKind, string> = ascii
  ? asciiEventGlyph
  : unicodeEventGlyph;

/** Smooth braille spinner; ASCII terminals get a simple rotation. */
export const spinnerFrames = ascii
  ? ['-', '\\', '|', '/']
  : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── Motion vocabulary (the "Cobalt" futuristic accents) ─────────────────────

/** The pulsing "live" dot — Excalibur's signature beat. Degrades to ASCII. */
export const pulseGlyph = ascii ? '*' : '●';

/**
 * One "breath" of the accent: a smooth ramp up to the bright crest and back.
 * Indexed by an animation tick, it makes any live element pulse in blue. The
 * sequence is deliberately asymmetric-free (palindromic) so it reads as a calm
 * inhale/exhale rather than a strobe.
 */
export function pulseStops(p: Palette): readonly string[] {
  return [p.accentDeep, p.accentDim, p.accent, p.accentBright, p.accent, p.accentDim];
}

/** The accent hex for a breathing "live" element at the given animation tick. */
export function pulseColor(p: Palette, tick: number): string {
  const stops = pulseStops(p);
  const i = ((Math.floor(tick) % stops.length) + stops.length) % stops.length;
  return stops[i] ?? p.accent;
}

/** Sub-cell rising blocks (empty → full) for the status micro-gauge. */
const GAUGE_CELLS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * A compact N-cell gauge for a ratio in [0,1]: cells rise as the value fills, so
 * the status line shows context/token pressure as a futuristic micro-equalizer
 * instead of a bare percentage. Returns the per-cell glyphs (the renderer colors
 * filled cells with the accent ramp and empties with the rail tone); ASCII gets
 * `#`/`.`. The boolean parallels which cells are "live" so callers can paint.
 */
export function gaugeCells(ratio: number, cells: number): { glyph: string; filled: boolean }[] {
  const r = Math.max(0, Math.min(1, ratio));
  const out: { glyph: string; filled: boolean }[] = [];
  for (let i = 0; i < cells; i++) {
    const fill = Math.max(0, Math.min(1, r * cells - i));
    out.push({
      glyph: ascii ? (fill > 0 ? '#' : '.') : (GAUGE_CELLS[Math.round(fill * 8)] ?? ' '),
      filled: fill > 0,
    });
  }
  return out;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Compact token count: 1234 → "1.2k", 980 → "980", 1_500_000 → "1.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatElapsed(ms: number): string {
  // Sub-second runs (e.g. a fast Groq call) get one decimal so they never floor
  // to a misleading "0s".
  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

// ── Background detection ────────────────────────────────────────────────────

/** Explicit override (`EXCALIBUR_THEME`) or the terminal's COLORFGBG hint. Sync. */
export function detectThemeSync(): ThemeMode | null {
  const override = process.env['EXCALIBUR_THEME']?.toLowerCase();
  if (override === 'light' || override === 'dark') {
    return override;
  }
  // COLORFGBG is "fg;bg" or "fg;;bg"; the last field is the background colour index.
  const fgbg = process.env['COLORFGBG'];
  if (fgbg !== undefined) {
    const parts = fgbg.split(';');
    const bg = Number(parts[parts.length - 1]);
    if (!Number.isNaN(bg)) {
      // 0–6 and 8 are dark; 7 and 9–15 are light.
      return bg === 7 || bg >= 9 ? 'light' : 'dark';
    }
  }
  return null;
}

/**
 * Asks the terminal for its background colour via the OSC 11 escape sequence and
 * derives light/dark from perceived luminance. Resolves null when not a TTY or
 * the terminal doesn't answer within the timeout. Restores stdin cleanly.
 */
export async function queryTerminalBackground(timeoutMs = 120): Promise<ThemeMode | null> {
  const { stdin, stdout } = process;
  if (!stdout.isTTY || !stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return null;
  }

  return new Promise<ThemeMode | null>((resolve) => {
    let settled = false;
    const wasRaw = stdin.isRaw;

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      clearTimeout(timer);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* ignore */
      }
      stdin.pause();
    };
    const finish = (result: ThemeMode | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      const match = /rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(chunk.toString());
      if (match === null) return;
      const channel = (hex: string): number => parseInt(hex.slice(0, 2).padEnd(2, '0'), 16);
      const r = channel(match[1] ?? '0');
      const g = channel(match[2] ?? '0');
      const b = channel(match[3] ?? '0');
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      finish(luminance > 0.5 ? 'light' : 'dark');
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      stdout.write('\x1b]11;?\x07');
    } catch {
      finish(null);
    }
  });
}

/** Best available detection: override/COLORFGBG → OSC 11 query → default dark. */
export async function resolveThemeMode(): Promise<ThemeMode> {
  const sync = detectThemeSync();
  if (sync !== null) {
    return sync;
  }
  const queried = await queryTerminalBackground();
  return queried ?? 'dark';
}
