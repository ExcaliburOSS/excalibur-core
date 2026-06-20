import { detectColorTier, paint, type ColorTier } from '@excalibur/tui';

/**
 * The M-Shell welcome screen.
 *
 * A full-width framed box with an ACCENT-coloured border and the mixed-case
 * `Excalibur` title (blue→cyan gradient) + dim version breaking out of the top
 * border (legend style). Two columns — left: "Welcome back, <name>", a crisp
 * quadrant-pixel sword (¼-cell sub-pixels: a solid blue blade + gray crossguard
 * with a symmetric stepped point), the brand epigraph, then model/org/user;
 * right: a Tip and a What's-new. Width-adaptive (collapses to one column when
 * narrow), truecolor with graceful 256/16/none downsampling, pure-ASCII fallback
 * when `unicode` is false. Layout is alignment-verified at widths 80/72/64/50.
 */

export interface WelcomeContext {
  /** Excalibur CLI version (shown in the title), e.g. `1.0.1`. */
  version: string;
  /** First name (from `git config user.name`); falls back to a neutral greeting. */
  name: string;
  /** Active provider/model. */
  model: string;
  /** Organisation (git remote owner, or Enterprise org); empty hides the row. */
  org: string;
  /** User identity (git email); empty hides the row. */
  user: string;
  tip: string;
  whatsNew: string;
  /** Brand epigraph line (i18n `welcome.epigraph`); empty hides it. */
  epigraph: string;
  /** Terminal columns (e.g. `process.stdout.columns`). */
  width: number;
  /** Box-drawing + block glyphs (false → pure ASCII). */
  unicode: boolean;
}

const BLADE = '#2368d0';
const GUARD = '#686464';
const ACCENT = '#5bc8ff';
const DIMHEX = '#8b949e';
const WHITEHEX = '#e6edf3';

/** Visible width (strips full ANSI SGR; the glyphs we use are all width-1). */
function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(s: string, w: number): string {
  const d = w - vlen(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= w) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line.length > 0) out.push(line);
  return out;
}

const dim = (s: string, tier: ColorTier): string => paint(s, DIMHEX, tier);
const accentText = (s: string, tier: ColorTier): string => paint(s, ACCENT, tier);

/** Per-character blue→cyan gradient (#2368d0 → #78d2ff; plain at tier `none`). */
function gradient(text: string, tier: ColorTier): string {
  const lerp = (c1: number, c2: number, t: number): string =>
    Math.round(c1 + (c2 - c1) * t)
      .toString(16)
      .padStart(2, '0');
  const chars = [...text];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const t = chars.length > 1 ? i / (chars.length - 1) : 0;
    const hex = `#${lerp(35, 120, t)}${lerp(104, 210, t)}${lerp(208, 255, t)}`;
    out += paint(chars[i] ?? '', hex, tier);
  }
  return out;
}

// Map a 2×2 sub-pixel on/off pattern (TL,TR,BL,BR) to its quadrant block glyph.
const QUAD: Record<string, string> = {
  '0000': ' ',
  '1000': '▘',
  '0100': '▝',
  '0010': '▖',
  '0001': '▗',
  '1100': '▀',
  '0011': '▄',
  '1010': '▌',
  '0101': '▐',
  '1001': '▚',
  '0110': '▞',
  '1110': '▛',
  '1101': '▜',
  '1011': '▙',
  '0111': '▟',
  '1111': '█',
};

/**
 * Crisp horizontal sword in quadrant sub-pixels (¼-cell pixels): a solid blue
 * blade + a taller gray crossguard, NO fuller, with a symmetric stepped point.
 * The blade length adapts to `availCells` so it never overflows its column.
 * Returns one coloured string per terminal row.
 */
function swordBlock(tier: ColorTier, availCells: number): string[] {
  const guardW = 8; // sub-cols (=4 cells)
  const guardH = 18; // sub-rows (=9 cells)
  const bladeH = 5; // sub-rows
  const stepLen = 2; // sub-cols per taper step
  const tipCells = 2; // the taper below spans 4 sub-cols = 2 cells
  const maxBladeCells = Math.max(6, availCells - guardW / 2 - tipCells);
  const bladeLen = maxBladeCells * 2; // sub-cols

  const grid = new Map<string, string>();
  const set = (r: number, c: number, col: string): void => {
    grid.set(`${r},${c}`, col);
  };

  for (let c = 0; c < guardW; c++) for (let r = 0; r < guardH; r++) set(r, c, GUARD);
  const bladeTop = Math.floor((guardH - bladeH) / 2);
  const x0 = guardW;
  for (let c = x0; c < x0 + bladeLen; c++)
    for (let r = bladeTop; r < bladeTop + bladeH; r++) set(r, c, BLADE);
  let c = x0 + bladeLen;
  let shrink = 1;
  while (bladeH - 2 * shrink >= 1) {
    for (let k = 0; k < stepLen; k++) {
      for (let r = bladeTop + shrink; r < bladeTop + bladeH - shrink; r++) set(r, c, BLADE);
      c += 1;
    }
    shrink += 1;
  }

  let maxC = 0;
  for (const key of grid.keys()) {
    const col = Number(key.split(',')[1]);
    if (col > maxC) maxC = col;
  }
  const cellCols = Math.ceil((maxC + 1) / 2);
  const cellRows = Math.ceil(guardH / 2);
  const lines: string[] = [];
  for (let cr = 0; cr < cellRows; cr++) {
    let line = '';
    for (let cc = 0; cc < cellCols; cc++) {
      const tl = grid.get(`${cr * 2},${cc * 2}`);
      const tr = grid.get(`${cr * 2},${cc * 2 + 1}`);
      const bl = grid.get(`${cr * 2 + 1},${cc * 2}`);
      const br = grid.get(`${cr * 2 + 1},${cc * 2 + 1}`);
      const color = tl ?? tr ?? bl ?? br;
      if (color === undefined) {
        line += ' ';
        continue;
      }
      const key = (tl ? '1' : '0') + (tr ? '1' : '0') + (bl ? '1' : '0') + (br ? '1' : '0');
      line += paint(QUAD[key] ?? '█', color, tier);
    }
    lines.push(line);
  }
  return lines;
}

/** Pure-ASCII sword fallback (no block/box glyphs) for `unicode === false`. */
function swordAscii(maxW: number): string[] {
  const hilt = '>=[#]=';
  const tip = '=- - .';
  const blade = '='.repeat(Math.max(2, maxW - hilt.length - tip.length));
  const line = `${hilt}${blade}${tip}`;
  return [line, line];
}

function identityRow(label: string, value: string, tier: ColorTier): string {
  return `${pad(dim(label, tier), 8)}${value}`;
}

export function renderWelcome(ctx: WelcomeContext): string {
  const { version, name, model, org, user, tip, whatsNew, epigraph, unicode } = ctx;
  const tier = detectColorTier(process.env, process.stdout?.isTTY === true);
  const B = unicode
    ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

  const W = Math.max(48, Math.min(ctx.width > 0 ? ctx.width : 80, 100));
  const inner = W - 2;

  // Top border with the title (mixed-case, gradient) + dim version cutting it.
  const leadPlain = `${B.tl}${B.h} Excalibur v${version} `;
  const dashes = Math.max(0, inner - leadPlain.length + 1);
  const top =
    paint(`${B.tl}${B.h} `, ACCENT, tier) +
    gradient('Excalibur', tier) +
    ' ' +
    dim(`v${version}`, tier) +
    ' ' +
    paint(`${B.h.repeat(dashes)}${B.tr}`, ACCENT, tier);

  const leftMargin = 3;
  const rightMargin = 2;
  const gap = 3;
  const single = inner < 58;
  const usable = inner - leftMargin - rightMargin;
  const leftW = single ? usable : Math.floor((usable - gap) * 0.5);
  const rightW = single ? usable : usable - gap - leftW;

  const sword = unicode ? swordBlock(tier, leftW - 3) : swordAscii(leftW - 3);
  const swordRows = sword.map((l) => `   ${l}`);

  const identity: string[] = [identityRow('model', model, tier)];
  if (org.length > 0) identity.push(identityRow('org', org, tier));
  if (user.length > 0) identity.push(identityRow('user', user, tier));

  const epiLines =
    epigraph.trim().length > 0
      ? wrap(epigraph, Math.max(8, leftW - 3)).map((l) => `   ${dim(l, tier)}`)
      : [];

  const displayName = name.trim().length > 0 ? name : 'there';
  const left = [
    '',
    `Welcome back, ${paint(displayName, WHITEHEX, tier)}`,
    '',
    ...swordRows,
    '',
    ...epiLines,
    ...(epiLines.length > 0 ? [''] : []),
    ...identity,
    '',
  ];

  const tipLabel = unicode ? '▸ Tip' : '> Tip';
  const newLabel = unicode ? '▸ What’s new' : '> What’s new';
  const right = [
    '',
    accentText(tipLabel, tier),
    ...wrap(tip, rightW - 2).map((l) => `  ${dim(l, tier)}`),
    '',
    accentText(newLabel, tier),
    ...wrap(whatsNew, rightW - 2).map((l) => `  ${dim(l, tier)}`),
    '',
  ];

  const rows = Math.max(left.length, right.length);
  const V = accentText(B.v, tier);
  const body: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = pad(left[i] ?? '', leftW);
    if (single) {
      body.push(`${V}${' '.repeat(leftMargin)}${pad(l, usable)}${' '.repeat(rightMargin)}${V}`);
    } else {
      const r = pad(right[i] ?? '', rightW);
      body.push(
        `${V}${' '.repeat(leftMargin)}${l}${' '.repeat(gap)}${r}${' '.repeat(rightMargin)}${V}`,
      );
    }
  }
  const bottom = accentText(`${B.bl}${B.h.repeat(inner)}${B.br}`, tier);
  return [top, ...body, bottom].join('\n');
}
