/**
 * Excalibur terminal design tokens.
 *
 * A deliberately small palette — one accent, semantic states, heavy use of a
 * muted tone so the important thing pops. Glyphs degrade to ASCII when the
 * terminal lacks a Nerd/Unicode font (EXCALIBUR_ASCII=1 or NO_COLOR forces it).
 */

export const ascii = process.env['EXCALIBUR_ASCII'] === '1';

export const color = {
  accent: '#5BC8FF', // excalibur cyan-steel
  accentDim: '#3A7CA0',
  success: '#5AD18A',
  warn: '#F2C94C',
  danger: '#EB5757',
  text: '#E6EDF3',
  muted: '#8B949E',
  rail: '#3A4048',
} as const;

type GlyphSet = {
  done: string;
  running: string;
  pending: string;
  waiting: string;
  failed: string;
  railV: string;
  branch: string;
  sub: string;
  bar: string;
  barEmpty: string;
  logo: string;
};

const unicode: GlyphSet = {
  done: '✓',
  running: '◐',
  pending: '○',
  waiting: '⚑',
  failed: '✗',
  railV: '│',
  branch: '└',
  sub: '·',
  bar: '█',
  barEmpty: '░',
  logo: '▌',
};

const asciiSet: GlyphSet = {
  done: 'v',
  running: '*',
  pending: 'o',
  waiting: '!',
  failed: 'x',
  railV: '|',
  branch: '`-',
  sub: '-',
  bar: '#',
  barEmpty: '.',
  logo: '|',
};

export const glyph: GlyphSet = ascii ? asciiSet : unicode;

/** Smooth braille spinner; ASCII terminals get a simple rotation. */
export const spinnerFrames = ascii
  ? ['-', '\\', '|', '/']
  : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}
