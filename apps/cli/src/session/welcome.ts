import pc from 'picocolors';

/**
 * The M-Shell welcome screen (Slice A).
 *
 * A full-width framed box with two columns and the `EXCALIBUR` title breaking
 * out of the top border (legend style). Left column: "Welcome back, <name>", a
 * compact cyberpunk sword, then model / org / user. Right column: a Tip and a
 * What's-new. Width-adaptive (collapses to one column when narrow), accent via
 * picocolors (auto-off on NO_COLOR / non-TTY), pure-ASCII fallback when
 * `unicode` is false. Layout is alignment-verified at widths 80/72/64/50.
 */

export interface WelcomeContext {
  /** Excalibur CLI version (shown in the title), e.g. `0.1.0`. */
  version: string;
  /** First name (from `git config user.name`); falls back to a neutral greeting. */
  name: string;
  /** Active provider/model (e.g. `mock`). */
  model: string;
  /** Organisation (git remote owner, or Enterprise org); empty hides the row. */
  org: string;
  /** User identity (git email); empty hides the row. */
  user: string;
  tip: string;
  whatsNew: string;
  /** Terminal columns (e.g. `process.stdout.columns`). */
  width: number;
  /** Box-drawing + block glyphs (false → pure ASCII). */
  unicode: boolean;
}

const accent = (s: string): string => pc.cyan(pc.bold(s));

/** Visible width (strips ANSI; the glyphs we use are all width-1). */
function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '').length;
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

/** Compact cyberpunk sword sized to `maxW` so it never overflows its column. */
function swordLines(unicode: boolean, maxW: number): [string, string] {
  if (!unicode) {
    const hilt = '>=[#]=';
    const tip = '=- - .';
    const blade = '='.repeat(Math.max(2, maxW - hilt.length - tip.length));
    const line = `${hilt}${blade}${tip}`;
    return [line, line];
  }
  const tip = '▓▒░╾╼─ ·';
  const blade = '█'.repeat(Math.max(2, maxW - 4 - tip.length));
  return [`▟██╪${blade}${tip}`, `▜██╪${blade}${tip}`];
}

function identityRow(label: string, value: string): string {
  return `${pad(pc.dim(label), 8)}${value}`;
}

export function renderWelcome(ctx: WelcomeContext): string {
  const { version, name, model, org, user, tip, whatsNew, unicode } = ctx;
  const B = unicode
    ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
    : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

  const W = Math.max(48, Math.min(ctx.width > 0 ? ctx.width : 80, 84));
  const inner = W - 2;

  // Top border with the title (+ version) "breaking out" of the frame.
  const lead = `${B.tl}${B.h} ${accent('EXCALIBUR')} ${pc.dim(`v${version}`)} `;
  const dashes = Math.max(0, inner - vlen(lead) + 1);
  const top = `${lead}${B.h.repeat(dashes)}${B.tr}`;

  const leftMargin = 3;
  const rightMargin = 2;
  const gap = 3;
  const single = inner < 58;
  const usable = inner - leftMargin - rightMargin;
  const leftW = single ? usable : Math.floor((usable - gap) * 0.5);
  const rightW = single ? usable : usable - gap - leftW;

  const sword = swordLines(unicode, leftW - 3).map((l) => pc.cyan(l));
  const identity: string[] = [identityRow('model', model)];
  if (org.length > 0) identity.push(identityRow('org', org));
  if (user.length > 0) identity.push(identityRow('user', user));

  const displayName = name.trim().length > 0 ? name : 'there';
  const left = [
    '',
    `Welcome back, ${pc.bold(displayName)}`,
    '',
    `   ${sword[0]}`,
    `   ${sword[1]}`,
    '',
    ...identity,
    '',
  ];

  const tipLabel = unicode ? '▸ Tip' : '> Tip';
  const newLabel = unicode ? '▸ What’s new' : '> What’s new';
  const right = [
    '',
    accent(tipLabel),
    ...wrap(tip, rightW - 2).map((l) => `  ${pc.dim(l)}`),
    '',
    accent(newLabel),
    ...wrap(whatsNew, rightW - 2).map((l) => `  ${pc.dim(l)}`),
    '',
  ];

  const rows = Math.max(left.length, right.length);
  const body: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = pad(left[i] ?? '', leftW);
    if (single) {
      body.push(`${B.v}${' '.repeat(leftMargin)}${pad(l, usable)}${' '.repeat(rightMargin)}${B.v}`);
    } else {
      const r = pad(right[i] ?? '', rightW);
      body.push(
        `${B.v}${' '.repeat(leftMargin)}${l}${' '.repeat(gap)}${r}${' '.repeat(rightMargin)}${B.v}`,
      );
    }
  }
  return [top, ...body, `${B.bl}${B.h.repeat(inner)}${B.br}`].join('\n');
}
