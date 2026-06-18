import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, renderDiff } from './diff-view';
import { stripAnsi } from './color';

const MOD_DIFF = [
  '--- a/src/math.ts',
  '+++ b/src/math.ts',
  '@@ -1,4 +1,4 @@',
  ' export function add(a, b) {',
  '-  return a - b;',
  '+  return a + b;',
  ' }',
  '',
].join('\n');

const NEW_DIFF = [
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const x = 1;',
  '+export const y = 2;',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parses a modification: path, counts, kinds, line numbers', () => {
    const [file] = parseUnifiedDiff(MOD_DIFF);
    expect(file?.path).toBe('src/math.ts');
    expect(file?.isNew).toBe(false);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    const lines = file!.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(['context', 'del', 'add', 'context']);
    const del = lines.find((l) => l.kind === 'del');
    const add = lines.find((l) => l.kind === 'add');
    expect(del?.oldNo).toBe(2);
    expect(del?.newNo).toBeNull();
    expect(add?.newNo).toBe(2);
    expect(add?.oldNo).toBeNull();
  });

  it('flags a new file (--- /dev/null)', () => {
    const [file] = parseUnifiedDiff(NEW_DIFF);
    expect(file?.path).toBe('src/new.ts');
    expect(file?.isNew).toBe(true);
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
  });

  it('parses a PURE rename (no ---/+++/@@) into a rename DiffFile', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file?.isRename).toBe(true);
    expect(file?.path).toBe('src/new.ts');
    expect(file?.oldPath).toBe('src/old.ts');
    expect(file?.hunks).toEqual([]);
  });

  it('parses a BINARY change into a binary DiffFile', () => {
    const diff = [
      'diff --git a/logo.png b/logo.png',
      'index 1111..2222 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file?.isBinary).toBe(true);
    expect(file?.path).toBe('logo.png');
  });

  it('handles a rename WITH edits (rename markers + a hunk)', () => {
    const diff = [
      'diff --git a/a.ts b/b.ts',
      'similarity index 80%',
      'rename from a.ts',
      'rename to b.ts',
      '--- a/a.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-const a = 1;',
      '+const b = 2;',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file?.isRename).toBe(true);
    expect(file?.path).toBe('b.ts');
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
  });

  it('marks the word-level changed span of a del→add pair', () => {
    const [file] = parseUnifiedDiff(MOD_DIFF);
    const lines = file!.hunks[0]!.lines;
    const del = lines.find((l) => l.kind === 'del')!;
    const add = lines.find((l) => l.kind === 'add')!;
    expect(del.span).toBeDefined();
    expect(add.span).toBeDefined();
    // The changed span isolates the operator, not the whole line.
    expect(del.text.slice(del.span![0], del.span![1])).toContain('-');
    expect(add.text.slice(add.span![0], add.span![1])).toContain('+');
  });

  it('keeps surrogate pairs intact in the word span (no half-emoji)', () => {
    // 😀 (U+1F600) and 😁 (U+1F601) share a high surrogate and differ only in
    // the low surrogate — a UTF-16-unit prefix would split the pair mid-char.
    const diff = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1 +1 @@',
      '-x😀y',
      '+x😁y',
      '',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    const lines = file!.hunks[0]!.lines;
    const del = lines.find((l) => l.kind === 'del')!;
    const add = lines.find((l) => l.kind === 'add')!;
    // The changed span is the WHOLE emoji, never a lone surrogate half.
    expect(del.text.slice(del.span![0], del.span![1])).toBe('😀');
    expect(add.text.slice(add.span![0], add.span![1])).toBe('😁');
    // The common prefix ('x') sits cleanly before the span.
    expect(del.text.slice(0, del.span![0])).toBe('x');
  });
});

describe('renderDiff', () => {
  it('tier none is plain: carries path, gutter line numbers and content', () => {
    const lines = renderDiff(MOD_DIFF, { tier: 'none', width: 60 });
    const text = lines.join('\n');
    expect(text).toContain('src/math.ts');
    expect(text).toContain('+1');
    expect(text).toContain('−1');
    expect(text).toContain('return a + b;');
    expect(text).toContain('return a - b;');
    // No ANSI at tier none.
    expect(text).toBe(stripAnsi(text));
  });

  it('coloured output is byte-identical to plain once ANSI is stripped', () => {
    const plain = renderDiff(MOD_DIFF, { tier: 'none', width: 60 }).join('\n');
    const colored = renderDiff(MOD_DIFF, { tier: 'truecolor', mode: 'dark', width: 60 }).join('\n');
    expect(stripAnsi(colored)).toBe(plain);
  });

  it('truecolor emits a full-row background tint AND a word-level highlight', () => {
    const colored = renderDiff(MOD_DIFF, { tier: 'truecolor', mode: 'dark', width: 60 }).join('\n');
    expect(colored).toContain('\x1b[48;2;'); // a background (row tint / word highlight)
    expect(colored).toContain('\x1b[38;2;'); // a foreground
    // dark add row bg (#12351F → 18;53;31) and add word bg (#1F6F3D → 31;111;61).
    expect(colored).toContain('\x1b[48;2;18;53;31m');
    expect(colored).toContain('\x1b[48;2;31;111;61m');
  });

  it('downsamples to ansi16 (background = fg code + 10)', () => {
    const colored = renderDiff(MOD_DIFF, { tier: 'ansi16', mode: 'dark', width: 60 }).join('\n');
    // Some 4x/10x background SGR present (40–47 or 100–107).
    expect(/\x1b\[(4[0-7]|10[0-7])m/.test(colored)).toBe(true);
  });

  it('side-by-side: old | new columns with a separator, both versions present', () => {
    const lines = renderDiff(MOD_DIFF, { tier: 'none', width: 140, layout: 'side-by-side' });
    const text = lines.join('\n');
    expect(text).toContain('│'); // column separator
    // Some single row carries the old text on the left and the new on the right.
    const row = lines.find((l) => l.includes('return a - b;') && l.includes('return a + b;'));
    expect(row).toBeDefined();
    expect(stripAnsi(text)).toBe(text); // plain at tier none
  });

  it('auto layout: unified when narrow, side-by-side when wide', () => {
    const narrow = renderDiff(MOD_DIFF, { tier: 'none', width: 60, layout: 'auto' }).join('\n');
    const wide = renderDiff(MOD_DIFF, { tier: 'none', width: 140, layout: 'auto' }).join('\n');
    // Narrow stacks del above add (no row has both); wide pairs them on one row.
    expect(narrow.split('\n').some((l) => l.includes('return a - b;') && l.includes('return a + b;'))).toBe(false);
    expect(wide.split('\n').some((l) => l.includes('return a - b;') && l.includes('return a + b;'))).toBe(true);
  });
});
