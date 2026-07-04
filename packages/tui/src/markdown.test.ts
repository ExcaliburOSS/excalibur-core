import { describe, expect, it } from 'vitest';
import { highlightCode, inlineSpans, parseMarkdown } from './markdown';

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

  it('SYNTAX-HIGHLIGHTS an (unclosed) code fence into token spans (mid-stream)', () => {
    const lines = parseMarkdown('before\n```js\nconst a = 1;');
    expect(lines.map((l) => l.kind)).toEqual(['text', 'code']);
    const code = lines[1];
    // The full line is preserved as the join of its token spans…
    expect(code?.spans.map((s) => s.text).join('')).toBe('const a = 1;');
    // …and `const` is tagged as a keyword (highlighted), not one flat plain span.
    expect(code?.spans[0]).toEqual({ text: 'const', style: 'kw' });
  });

  it('does NOT syntax-highlight a diff fence (its add/del colouring wins)', () => {
    const lines = parseMarkdown('```diff\n+const a = 1;\n```');
    // A diff line stays ONE plain span so the code-add/del tint is not overwritten.
    expect(lines[0]?.kind).toBe('code-add');
    expect(lines[0]?.spans).toEqual([{ text: '+const a = 1;', style: 'plain' }]);
  });

  it('never throws on junk and trims outer blanks', () => {
    expect(parseMarkdown('')).toEqual([]);
    const lines = parseMarkdown('\n\nhola\n\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('text');
  });
});

describe('highlightCode (#3 — syntax token spans)', () => {
  const styleOf = (spans: ReturnType<typeof highlightCode>, text: string): string | undefined =>
    spans.find((s) => s.text === text)?.style;

  it('tags keywords, numbers and line comments (TS/JS)', () => {
    const spans = highlightCode('const x = 42; // note', 'ts');
    expect(styleOf(spans, 'const')).toBe('kw');
    expect(styleOf(spans, '42')).toBe('num');
    expect(spans.some((s) => s.style === 'com' && s.text.includes('// note'))).toBe(true);
    expect(spans.map((s) => s.text).join('')).toBe('const x = 42; // note');
  });

  it('tags Capitalized identifiers as types and keeps strings whole', () => {
    const spans = highlightCode('new Widget("hi")', 'ts');
    expect(styleOf(spans, 'new')).toBe('kw');
    expect(styleOf(spans, 'Widget')).toBe('ty');
    expect(styleOf(spans, '"hi"')).toBe('str');
    expect(spans.map((s) => s.text).join('')).toBe('new Widget("hi")');
  });

  it('uses # comments and its own keywords for Python', () => {
    const spans = highlightCode('def go(): # run', 'py');
    expect(styleOf(spans, 'def')).toBe('kw');
    expect(spans.some((s) => s.style === 'com' && s.text.includes('# run'))).toBe(true);
    // `def` is a JS-set non-keyword, so this proves the language switch took effect.
    expect(highlightCode('def go()', 'ts').find((s) => s.text === 'def')?.style).toBe('plain');
    expect(spans.map((s) => s.text).join('')).toBe('def go(): # run');
  });

  it('never throws and always preserves the full line', () => {
    for (const s of ['', '   ', '}{)(', '`unterminated', "'x", '/* c */ x', '你好 x']) {
      const spans = highlightCode(s, 'ts');
      expect(spans.map((sp) => sp.text).join('')).toBe(s);
    }
  });
});
