import { paint, paintBg, type ColorTier } from './color';
import { getColors, type ThemeMode } from './theme';

/**
 * The DIFF VIEWER — a real, syntax-aware unified-diff renderer (P1.2). Beats
 * Claude Code (which washes out +/− in truecolor and strips context) and
 * OpenCode by carrying: a line-number gutter (old/new), a full-row tint per
 * add/del, **word-level intra-line highlight** (the changed spans within a
 * del→add pair get a brighter background), and PRESERVED context (never
 * truncated). Pure `(diff, opts) => string[]`; at tier `none` the output is
 * byte-identical to plain text, so it composes with the rail and golden tests.
 */

export type DiffLineKind = 'add' | 'del' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content WITHOUT the leading +/−/space marker. */
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** `[start, end)` char range (in `text`) that changed vs its pair, if any. */
  span?: readonly [number, number];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDelete: boolean;
  hunks: DiffHunk[];
}

/** Strips an `a/`/`b/` prefix and a trailing tab-timestamp from a diff path. */
function cleanPath(raw: string): string {
  const noTab = raw.split('\t')[0] ?? raw;
  return noTab.replace(/^[ab]\//, '').trim();
}

/** Parses a unified diff into structured files/hunks/lines with line numbers. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let pendingOld: string | null = null;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('--- ')) {
      pendingOld = raw.slice(4).trim();
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const newRaw = raw.slice(4).trim();
      const isNew = pendingOld === '/dev/null';
      const isDelete = newRaw === '/dev/null';
      const path = isDelete ? cleanPath(pendingOld ?? '') : cleanPath(newRaw);
      file = {
        path,
        oldPath: pendingOld !== null && !isNew ? cleanPath(pendingOld) : null,
        additions: 0,
        deletions: 0,
        isNew,
        isDelete,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      pendingOld = null;
      continue;
    }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (at !== null) {
      oldNo = Number.parseInt(at[1] ?? '0', 10);
      newNo = Number.parseInt(at[2] ?? '0', 10);
      hunk = { header: raw, lines: [] };
      file?.hunks.push(hunk);
      continue;
    }
    if (file === null || hunk === null) {
      continue; // preamble (diff --git, index, mode lines) — not rendered
    }
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text, oldNo: null, newNo });
      newNo += 1;
      file.additions += 1;
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text, oldNo, newNo: null });
      oldNo += 1;
      file.deletions += 1;
    } else if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
    // '\' (No newline at end of file) and blank trailing lines are skipped.
  }

  for (const f of files) {
    for (const h of f.hunks) {
      computeWordSpans(h.lines);
    }
  }
  return files;
}

/**
 * Marks the changed character span of each paired del→add line (common prefix +
 * common suffix → the middle is what changed), GitHub-style. Pairs by index
 * within a contiguous del-run immediately followed by an add-run.
 */
function computeWordSpans(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind !== 'del') {
      i += 1;
      continue;
    }
    let d = i;
    while (lines[d]?.kind === 'del') d += 1;
    let a = d;
    while (lines[a]?.kind === 'add') a += 1;
    const dels = lines.slice(i, d);
    const adds = lines.slice(d, a);
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k += 1) {
      const del = dels[k]!;
      const add = adds[k]!;
      const span = spanOf(del.text, add.text);
      if (span !== null) {
        del.span = span.del;
        add.span = span.add;
      }
    }
    i = a > i ? a : i + 1;
  }
}

function spanOf(
  delText: string,
  addText: string,
): { del: readonly [number, number]; add: readonly [number, number] } | null {
  let p = 0;
  const min = Math.min(delText.length, addText.length);
  while (p < min && delText[p] === addText[p]) p += 1;
  let s = 0;
  while (
    s < delText.length - p &&
    s < addText.length - p &&
    delText[delText.length - 1 - s] === addText[addText.length - 1 - s]
  ) {
    s += 1;
  }
  const delEnd = delText.length - s;
  const addEnd = addText.length - s;
  // No change, or the whole line changed (no useful sub-span) → skip highlight.
  if (p >= delEnd && p >= addEnd) return null;
  if (p === 0 && delEnd === delText.length && addEnd === addText.length) return null;
  return { del: [p, delEnd], add: [p, addEnd] };
}

export interface RenderDiffOptions {
  tier?: ColorTier;
  mode?: ThemeMode;
  /** Terminal width; rows are tinted to this width so the bg reaches the edge. */
  width?: number;
}

/** Renders a unified diff into colour-tiered lines (the diff viewport body). */
export function renderDiff(diff: string, options: RenderDiffOptions = {}): string[] {
  const tier = options.tier ?? 'none';
  const palette = getColors(options.mode ?? 'dark');
  const width = options.width ?? 80;
  const files = parseUnifiedDiff(diff);
  const out: string[] = [];

  for (const file of files) {
    const tag = file.isNew ? ' (new)' : file.isDelete ? ' (deleted)' : '';
    const head = paint(`▌ ${file.path}${tag}`, palette.accent, tier);
    const adds = paint(`+${file.additions}`, palette.diffAddFg, tier);
    const dels = paint(`−${file.deletions}`, palette.diffDelFg, tier);
    out.push(`${head}  ${adds} ${dels}`);
    // Gutter width from the largest line number across the file.
    let maxNo = 1;
    for (const h of file.hunks) {
      for (const l of h.lines) {
        maxNo = Math.max(maxNo, l.oldNo ?? 0, l.newNo ?? 0);
      }
    }
    const numW = String(maxNo).length;
    const gutterW = numW * 2 + 3; // "old new " + a separator space
    const contentW = Math.max(8, width - gutterW);

    for (const h of file.hunks) {
      out.push(paint(h.header, palette.accentDim, tier));
      for (const line of h.lines) {
        out.push(renderLine(line, { tier, palette, numW, contentW }));
      }
    }
  }
  return out;
}

function renderLine(
  line: DiffLine,
  ctx: { tier: ColorTier; palette: ReturnType<typeof getColors>; numW: number; contentW: number },
): string {
  const { tier, palette, numW, contentW } = ctx;
  const oldStr = (line.oldNo === null ? '' : String(line.oldNo)).padStart(numW);
  const newStr = (line.newNo === null ? '' : String(line.newNo)).padStart(numW);
  const gutter = paint(`${oldStr} ${newStr} `, palette.muted, tier);

  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  const raw = `${marker}${line.text}`;
  const padded = raw.length >= contentW ? raw : raw + ' '.repeat(contentW - raw.length);

  if (line.kind === 'context') {
    return `${gutter}${paint(padded, palette.muted, tier)}`;
  }
  const fg = line.kind === 'add' ? palette.diffAddFg : palette.diffDelFg;
  const bg = line.kind === 'add' ? palette.diffAddBg : palette.diffDelBg;
  const wordBg = line.kind === 'add' ? palette.diffAddWordBg : palette.diffDelWordBg;

  if (line.span === undefined) {
    return `${gutter}${paintBg(padded, bg, tier, fg)}`;
  }
  // span is in `text` coords; `raw` prepends the 1-char marker → shift by 1.
  const a = 1 + line.span[0];
  const b = 1 + line.span[1];
  const pre = padded.slice(0, a);
  const mid = padded.slice(a, b);
  const post = padded.slice(b);
  return `${gutter}${paintBg(pre, bg, tier, fg)}${paintBg(mid, wordBg, tier, fg)}${paintBg(post, bg, tier, fg)}`;
}
