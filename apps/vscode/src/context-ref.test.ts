import { describe, expect, it } from 'vitest';
import { buildPrompt, locationHeader, type EditorContext } from './context-ref';

describe('locationHeader', () => {
  it('formats a multi-line selection range', () => {
    const ctx: EditorContext = {
      filePath: 'src/app.ts',
      selection: { startLine: 37, endLine: 42, text: 'x' },
    };
    expect(locationHeader(ctx)).toBe('src/app.ts (lines 37-42)');
  });

  it('formats a single-line selection', () => {
    const ctx: EditorContext = {
      filePath: 'src/app.ts',
      selection: { startLine: 5, endLine: 5, text: 'x' },
    };
    expect(locationHeader(ctx)).toBe('src/app.ts (line 5)');
  });

  it('falls back to just the file, or empty', () => {
    expect(locationHeader({ filePath: 'a.ts' })).toBe('a.ts');
    expect(locationHeader({})).toBe('');
  });
});

describe('buildPrompt', () => {
  it('returns the bare instruction when there is no editor context', () => {
    expect(buildPrompt('hello')).toBe('hello');
  });

  it('embeds the selection with a precise file:line header and a fenced block', () => {
    const prompt = buildPrompt('What does this do?', {
      filePath: 'src/math.ts',
      languageId: 'typescript',
      selection: { startLine: 1, endLine: 2, text: 'export const x = 1;' },
    });
    expect(prompt).toContain('What does this do?');
    expect(prompt).toContain('selected code from src/math.ts (lines 1-2)');
    expect(prompt).toContain('```typescript');
    expect(prompt).toContain('export const x = 1;');
  });

  it('embeds the whole document when asked (no selection)', () => {
    const prompt = buildPrompt('Explain it.', {
      filePath: 'src/math.ts',
      languageId: 'typescript',
      documentText: 'export function add() {}',
    });
    expect(prompt).toContain('the file src/math.ts');
    expect(prompt).toContain('export function add() {}');
  });

  it('notes the active file when there is no code to embed', () => {
    expect(buildPrompt('do x', { filePath: 'src/a.ts' })).toContain('(Active file: src/a.ts)');
  });

  it('truncates an oversized snippet', () => {
    const huge = 'a'.repeat(20_000);
    const prompt = buildPrompt('review', {
      filePath: 'big.ts',
      selection: { startLine: 1, endLine: 999, text: huge },
    });
    expect(prompt).toContain('… (truncated)');
    expect(prompt.length).toBeLessThan(huge.length);
  });

  it('uses a longer fence when the code itself contains a triple backtick', () => {
    // A markdown file whose content has a ``` block (e.g. README) must not break
    // out of the surrounding fence.
    const code = ['# Title', '', '```', 'nested code', '```', ''].join('\n');
    const prompt = buildPrompt('review', {
      filePath: 'README.md',
      languageId: 'markdown',
      selection: { startLine: 1, endLine: 6, text: code },
    });
    // The wrapping fence must be 4+ backticks so the inner ``` stays contained.
    expect(prompt).toContain('````markdown');
    expect(prompt).toContain('nested code');
    // The inner triple-backtick survives verbatim inside the 4-backtick fence.
    expect(prompt).toContain('```\nnested code\n```');
  });

  it('ignores an empty/whitespace selection', () => {
    const prompt = buildPrompt('do x', {
      filePath: 'a.ts',
      selection: { startLine: 1, endLine: 1, text: '   ' },
    });
    expect(prompt).not.toContain('```');
    expect(prompt).toContain('Active file: a.ts');
  });
});
