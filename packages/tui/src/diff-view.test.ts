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
});
