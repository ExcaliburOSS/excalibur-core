/**
 * The color foundation for the LIVING RAIL (build STEP 1).
 *
 * Excalibur uses a single hex accent + semantic state colours (see `theme.ts`).
 * Terminals vary wildly in what they can render, so every hex is downsampled to
 * the terminal's real capability: truecolor (24-bit) → 256-colour cube → the 16
 * ANSI basics → no colour at all (NO_COLOR / non-TTY / `dumb`). The same painted
 * line therefore stays faithful on iTerm truecolor AND a bare CI log, which is
 * how we beat the washed-out truecolor output of other tools on 256-colour
 * terminals: we resolve DOWN to a colour the terminal actually has.
 */

export type ColorTier = 'truecolor' | 'ansi256' | 'ansi16' | 'none';

const RESET = '\x1b[0m';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses `#rrggbb` (or `rrggbb`) into 0–255 channels; null on a bad input. */
export function hexToRgb(hex: string): Rgb | null {
  const cleaned = hex.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return null;
  }
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

/**
 * Linear blend of two `#rrggbb` colours at t∈[0,1] (0 = a, 1 = b), returned as
 * `#rrggbb`. Used for subtle gradients (e.g. the rail connector fading from the
 * accent at the live node to the rail tone below). Bad inputs fall back to `a`.
 */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (ca === null || cb === null) return a;
  const k = Math.max(0, Math.min(1, t));
  const ch = (x: number, y: number): string =>
    Math.round(x + (y - x) * k)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(ca.r, cb.r)}${ch(ca.g, cb.g)}${ch(ca.b, cb.b)}`;
}

/**
 * Resolves the terminal's colour capability. Order: NO_COLOR forces off;
 * FORCE_COLOR / EXCALIBUR_FORCE_COLOR force a level (handy for tests and piped
 * output); otherwise sniff COLORTERM/TERM, defaulting a TTY to 16 colours and a
 * non-TTY to none.
 */
export function detectColorTier(env: NodeJS.ProcessEnv = process.env, isTty?: boolean): ColorTier {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') {
    return 'none';
  }
  const forced = env['EXCALIBUR_FORCE_COLOR'] ?? env['FORCE_COLOR'];
  if (forced !== undefined) {
    switch (forced) {
      case '0':
      case 'false':
        return 'none';
      case '1':
        return 'ansi16';
      case '2':
        return 'ansi256';
      case '3':
      case 'true':
        return 'truecolor';
      default:
        break;
    }
  }
  const term = env['TERM'] ?? '';
  if (term === 'dumb') {
    return 'none';
  }
  const tty = isTty ?? Boolean(process.stdout?.isTTY);
  if (!tty) {
    return 'none';
  }
  const colorterm = (env['COLORTERM'] ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') {
    return 'truecolor';
  }
  if (/256(color)?/.test(term)) {
    return 'ansi256';
  }
  return 'ansi16';
}

/** Channel 0–255 → 0–5 index on the xterm 6×6×6 colour cube. */
function cubeIndex(value: number): number {
  if (value < 48) return 0;
  if (value < 115) return 1;
  return Math.min(5, Math.round((value - 35) / 40));
}

/** Nearest xterm-256 palette index for an RGB triple (cube + grayscale ramp). */
export function rgbToAnsi256({ r, g, b }: Rgb): number {
  // Greys collapse to the dedicated 24-step ramp for smoother neutrals.
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * cubeIndex(r) + 6 * cubeIndex(g) + cubeIndex(b);
}

// The 16 standard ANSI colours as RGB, in SGR index order (30–37, 90–97).
const ANSI16: ReadonlyArray<Rgb & { code: number }> = [
  { r: 0, g: 0, b: 0, code: 30 },
  { r: 205, g: 49, b: 49, code: 31 },
  { r: 13, g: 188, b: 121, code: 32 },
  { r: 229, g: 229, b: 16, code: 33 },
  { r: 36, g: 114, b: 200, code: 34 },
  { r: 188, g: 63, b: 188, code: 35 },
  { r: 17, g: 168, b: 205, code: 36 },
  { r: 229, g: 229, b: 229, code: 37 },
  { r: 102, g: 102, b: 102, code: 90 },
  { r: 241, g: 76, b: 76, code: 91 },
  { r: 35, g: 209, b: 139, code: 92 },
  { r: 245, g: 245, b: 67, code: 93 },
  { r: 59, g: 142, b: 234, code: 94 },
  { r: 214, g: 112, b: 214, code: 95 },
  { r: 41, g: 184, b: 219, code: 96 },
  { r: 255, g: 255, b: 255, code: 97 },
];

/** Nearest 16-colour SGR foreground code for an RGB triple (squared distance). */
export function rgbToAnsi16({ r, g, b }: Rgb): number {
  let best = ANSI16[0]!;
  let bestDist = Infinity;
  for (const c of ANSI16) {
    const dist = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best.code;
}

/** The SGR foreground introducer for a hex colour at a given tier (no reset). */
export function fgSequence(hex: string, tier: ColorTier): string {
  if (tier === 'none') {
    return '';
  }
  const rgb = hexToRgb(hex);
  if (rgb === null) {
    return '';
  }
  switch (tier) {
    case 'truecolor':
      return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
    case 'ansi256':
      return `\x1b[38;5;${rgbToAnsi256(rgb)}m`;
    case 'ansi16':
      return `\x1b[${rgbToAnsi16(rgb)}m`;
  }
}

/**
 * Paints `text` in `hex`, downsampled to `tier`. At tier `none` (or an
 * unparseable hex) the text is returned untouched — so the no-colour path is
 * byte-identical to the plain renderer.
 */
export function paint(text: string, hex: string, tier: ColorTier): string {
  const seq = fgSequence(hex, tier);
  return seq === '' ? text : `${seq}${text}${RESET}`;
}

/** The SGR BACKGROUND introducer for a hex colour at a given tier (no reset). */
export function bgSequence(hex: string, tier: ColorTier): string {
  if (tier === 'none') {
    return '';
  }
  const rgb = hexToRgb(hex);
  if (rgb === null) {
    return '';
  }
  switch (tier) {
    case 'truecolor':
      return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
    case 'ansi256':
      return `\x1b[48;5;${rgbToAnsi256(rgb)}m`;
    case 'ansi16':
      // Background SGR = foreground code + 10 (30→40, 90→100).
      return `\x1b[${rgbToAnsi16(rgb) + 10}m`;
  }
}

/**
 * Paints `text` with a background tint (and optional foreground), downsampled to
 * `tier`. At tier `none` the text is returned untouched (byte-identical plain).
 */
export function paintBg(text: string, bgHex: string, tier: ColorTier, fgHex?: string): string {
  const bg = bgSequence(bgHex, tier);
  if (bg === '') {
    return text;
  }
  const fg = fgHex !== undefined ? fgSequence(fgHex, tier) : '';
  return `${bg}${fg}${text}${RESET}`;
}

/** Strips SGR escape sequences — used by snapshot tests to compare plain text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}
