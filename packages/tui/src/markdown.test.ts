import { describe, expect, it } from 'vitest';
import { inlineSpans, parseMarkdown } from './markdown';

describe('inlineSpans', () => {
  it('splits `code`, **bold** and *italic* runs', () => {
    expect(inlineSpans('run `npm test` and **check** the *output*')).toEqual([
      { text: 'run ', style: 'plain' },
      { text: 'npm test', style: 'code' },
      { text: ' and ', style: 'plain' },
      { text: 'check', style: 'bold' },
      { text: ' the ', style: 'plain' },
      { text: 'output', style: 'italic' },
    ]);
  });

  it('leaves unbalanced markers literal (streaming safety)', () => {
    expect(inlineSpans('an unclosed `backtick and **bold')).toEqual([
      { text: 'an unclosed `backtick and **bold', style: 'plain' },
    ]);
  });

  it('does not treat multiplication asterisks as emphasis', () => {
    expect(inlineSpans('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4', style: 'plain' }]);
  });
});

describe('parseMarkdown', () => {
  it('classifies headings, quotes, bullets and ordered items', () => {
    const lines = parseMarkdown('## Proposed patch\n> a note\n- first\n2. second');
    expect(lines.map((l) => l.kind)).toEqual(['heading', 'quote', 'bullet', 'bullet']);
    expect(lines[0]?.spans[0]?.text).toBe('Proposed patch');
    expect(lines[2]?.marker).toBe('•');
    expect(lines[3]?.marker).toBe('2.');
  });

  it('renders fenced blocks as code and diff fences with add/del kinds', () => {
    const lines = parseMarkdown('```diff\n+added\n-removed\n@@ hunk\nctx\n```\nafter');
    expect(lines.map((l) => l.kind)).toEqual(['code-add', 'code-del', 'code-meta', 'code', 'text']);
  });

  it('keeps an UNCLOSED fence rendering as code (mid-stream)', () => {
    const lines = parseMarkdown('before\n```js\nconst a = 1;');
    expect(lines.map((l) => l.kind)).toEqual(['text', 'code']);
    expect(lines[1]?.spans[0]?.text).toBe('const a = 1;');
  });

  it('never throws on junk and trims outer blanks', () => {
    expect(parseMarkdown('')).toEqual([]);
    const lines = parseMarkdown('\n\nhola\n\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('text');
  });
});
