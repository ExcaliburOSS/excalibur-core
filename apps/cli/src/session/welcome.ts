import {
  detectColorTier,
  detectThemeSync,
  getColors,
  paint,
  type ColorTier,
  type Palette,
} from '@excalibur/tui';

/**
 * The M-Shell welcome screen — D8 (F1.5): a compact HERO, not a billboard.
 *
 * The previous screen was 21 rows with a two-column layout whose dim paragraphs
 * buried its own content (the audit: "no focal moment; the sword reads as a blue
 * rectangle"). This keeps the two moments that genuinely worked — the mixed-case
 * gradient `Excalibur` title cutting the top border and the amber `beta` chip —
 * and compresses everything else into seven rows: a 2-row sword beside the
 * greeting + one-line identity, the brand epigraph with a line of its own, and
 * exactly ONE tip. Width-adaptive (the sword steps aside on narrow terminals),
 * truecolor with graceful 256/16/none downsampling, pure-ASCII fallback when
 * `unicode` is false. Nothing here ever wraps — long lines truncate with `…`.
 */

export interface WelcomeContext {
  /** Excalibur CLI version (shown in the title), e.g. `1.0.1`. */
  version: string;
  /** The localized greeting, already formatted (e.g. `Welcome back, Rafael`). */
  greeting: string;
  /** Active provider/model. */
  model: string;
  /** Organisation (git remote owner, or Enterprise org); empty hides it. */
  org: string;
  /** User identity (git email); empty hides it. */
  user: string;
  tip: string;
  /** Brand epigraph line (i18n `welcome.epigraph`); empty hides it. */
  epigraph: string;
  /** Terminal columns (e.g. `process.stdout.columns`). */
  width: number;
  /** Box-drawing + block glyphs (false → pure ASCII). */
  unicode: boolean;
}

// The sword + frame are themed from the canonical Cobalt palette (following the
// terminal's light/dark) instead of hardcoded constants, so the welcome screen
// re-colours with the active theme: blade = the deep sword-blue, frame/title =
// the primary accent, with a cool-grey crossguard.
const PALETTE: Palette = getColors(detectThemeSync() ?? 'dark');
const BLADE = PALETTE.accentDeep; // sword-blade blue
const GUARD = '#5a6678'; // cool neutral crossguard
const ACCENT = PALETTE.accent; // border + title + tips
const DIMHEX = PALETTE.muted;
const WHITEHEX = PALETTE.text;
const WARNHEX = PALETTE.warn; // amber/coral — the "beta" maturity chip

/** RGB channel (0=r,1=g,2=b) of a `#rrggbb` hex. */
const chan = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
// Sword/title gradient endpoints: deep blade → bright glow (palette-derived).
const GRAD_FROM: readonly [number, number, number] = [
  chan(BLADE, 0),
  chan(BLADE, 1),
  chan(BLADE, 2),
];
const GRAD_TO: readonly [number, number, number] = [
  chan(PALETTE.accentBright, 0),
  chan(PALETTE.accentBright, 1),
  chan(PALETTE.accentBright, 2),
];

/** Visible width (strips full ANSI SGR; the glyphs we use are all width-1). */
function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(s: string, w: number): string {
  const d = w - vlen(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

/** Truncates PLAIN text (no ANSI) to `w` visible cells with an ellipsis. */
function cut(s: string, w: number): string {
  const chars = [...s];
  return chars.length <= w ? s : `${chars.slice(0, Math.max(0, w - 1)).join('')}…`;
}

const dim = (s: string, tier: ColorTier): string => paint(s, DIMHEX, tier);
const accentText = (s: string, tier: ColorTier): string => paint(s, ACCENT, tier);

/** Per-character deep-blade→bright-glow gradient (palette-derived; plain at tier `none`). */
function gradient(text: string, tier: ColorTier): string {
  const lerp = (c1: number, c2: number, t: number): string =>
    Math.round(c1 + (c2 - c1) * t)
      .toString(16)
      .padStart(2, '0');
  const chars = [...text];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0;
    const hex = `#${lerp(GRAD_FROM[0], GRAD_TO[0], t)}${lerp(GRAD_FROM[1], GRAD_TO[1], t)}${lerp(
      GRAD_FROM[2],
      GRAD_TO[2],
      t,
    )}`;
    out += paint(chars[i] ?? '', hex, tier);
  }
  return out;
}

/**
 * The 2-row hero sword: a grey crossguard + grip, a gradient blade (deep blue at
 * the guard, glowing at the point) and a bright tip. Row 2 is padded to row 1's
 * width so text beside the sword stays column-aligned. ASCII: one plain line.
 */
function heroSword(tier: ColorTier, bladeCells: number, unicode: boolean): [string, string] {
  if (!unicode) {
    const line = `=[#]${'='.repeat(Math.max(4, bladeCells - 2))}>`;
    return [line, ' '.repeat(vlen(line))];
  }
  const row1 = `${paint('▄▄', GUARD, tier)}${gradient('█'.repeat(bladeCells), tier)}${paint(
    '▶',
    PALETTE.accentBright,
    tier,
  )}`;
  const row2 = pad(`${paint('▀▀', GUARD, tier)}${paint('██', GUARD, tier)}`, vlen(row1));
  return [row1, row2];
}

export function renderWelcome(ctx: WelcomeContext): string {
  const { version, greeting, model, org, user, tip, epigraph, unicode } = ctx;
  const tier = detectColorTier(process.env, process.stdout?.isTTY === true);
  const B = unicode
    ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

  const W = Math.max(48, Math.min(ctx.width > 0 ? ctx.width : 80, 100));
  const inner = W - 2;

  // Top border with the title (mixed-case, gradient) + dim version + a small amber
  // `beta` maturity chip cutting the border (Excalibur is in public beta — honest in
  // the product itself, matching the web + READMEs).
  const leadPlain = `${B.tl}${B.h} Excalibur v${version} · beta `;
  const dashes = Math.max(0, inner - leadPlain.length + 1);
  const top =
    paint(`${B.tl}${B.h} `, ACCENT, tier) +
    gradient('Excalibur', tier) +
    ' ' +
    dim(`v${version}`, tier) +
    ' ' +
    dim('· ', tier) +
    paint('beta', WARNHEX, tier) +
    ' ' +
    paint(`${B.h.repeat(dashes)}${B.tr}`, ACCENT, tier);

  const margin = 3;
  const usable = inner - margin - 2;
  const gap = 3;

  // The sword steps aside on narrow terminals rather than squeezing the text.
  const withSword = usable >= 44;
  const bladeCells = Math.max(8, Math.min(20, usable - 34));
  const [swordA, swordB] = withSword ? heroSword(tier, bladeCells, unicode) : ['', ''];
  const swordW = withSword ? vlen(swordA) : 0;
  const textW = usable - (withSword ? swordW + gap : 0);
  const beside = (sword: string, text: string): string =>
    withSword ? `${sword}${' '.repeat(gap)}${text}` : text;

  const identity = [model, user, org].filter((v) => v.length > 0).join(' · ');
  const lineA = beside(swordA, paint(cut(greeting, textW), WHITEHEX, tier));
  const lineB = beside(swordB, dim(cut(identity, textW), tier));
  const epiLine = epigraph.trim().length > 0 ? paint(cut(epigraph, usable), WHITEHEX, tier) : null;
  const tipMark = unicode ? '▸ ' : '> ';
  const tipLine = `${accentText(tipMark, tier)}${dim(cut(tip, usable - tipMark.length), tier)}`;

  const V = accentText(B.v, tier);
  const body = [lineA, lineB, '', ...(epiLine !== null ? [epiLine] : []), tipLine].map(
    (l) => `${V}${' '.repeat(margin)}${pad(l, usable)}  ${V}`,
  );
  const bottom = accentText(`${B.bl}${B.h.repeat(inner)}${B.br}`, tier);
  return [top, ...body, bottom].join('\n');
}
