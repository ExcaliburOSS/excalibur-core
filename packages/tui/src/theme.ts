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
  accent: string;
  accentDim: string;
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

/** Tuned for dark backgrounds (bright text, vivid accents). */
export const darkColors: Palette = {
  mode: 'dark',
  accent: '#5BC8FF',
  accentDim: '#3A7CA0',
  success: '#5AD18A',
  warn: '#F2C94C',
  danger: '#EB5757',
  text: '#E6EDF3',
  muted: '#8B949E',
  rail: '#3A4048',
  // GitHub-dark-like diff tints: faint row bg + a brighter word-level bg.
  diffAddFg: '#7EE2A8',
  diffDelFg: '#FF8A8A',
  diffAddBg: '#12351F',
  diffDelBg: '#3A1414',
  diffAddWordBg: '#1F6F3D',
  diffDelWordBg: '#7A2222',
};

/** Tuned for light backgrounds (dark text, deeper accents — GitHub-light-like). */
export const lightColors: Palette = {
  mode: 'light',
  accent: '#0969DA',
  accentDim: '#0a4b9c',
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
