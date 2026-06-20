import { describe, expect, it } from 'vitest';
import { formatCitations, hashContent, makeCitedSource, renderCitedReport } from './citations';

describe('citations', () => {
  it('hashes content deterministically', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });

  it('builds a cited source with a content hash', () => {
    const s = makeCitedSource('https://x.test/', 'Title', 'body', '2026-06-20T00:00:00.000Z');
    expect(s.url).toBe('https://x.test/');
    expect(s.sha256).toBe(hashContent('body'));
    expect(s.fetchedAt).toBe('2026-06-20T00:00:00.000Z');
  });

  it('falls back to the URL when the title is empty', () => {
    expect(makeCitedSource('https://x.test/', '', 'b', 't').title).toBe('https://x.test/');
  });

  it('renders a numbered, verifiable report', () => {
    const sources = [
      makeCitedSource('https://a.test/', 'A', 'aa', 't'),
      makeCitedSource('https://b.test/', 'B', 'bb', 't'),
    ];
    const report = renderCitedReport('Q?', 'answer with [1] and [2]', sources);
    expect(report).toContain('# Research: Q?');
    expect(report).toContain('[1] A — https://a.test/');
    expect(report).toContain('[2] B — https://b.test/');
    expect(formatCitations(sources)).toContain('sha256');
  });
});
