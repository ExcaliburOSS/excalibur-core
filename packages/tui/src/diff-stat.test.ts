import { describe, expect, it } from 'vitest';
import { formatDiffStat, parseDiffStat } from './diff-stat.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 context line
-old line
+new line one
+new line two
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +10,2 @@
-removed
+added`;

describe('parseDiffStat', () => {
  it('counts additions, deletions and files, ignoring headers and hunks', () => {
    const stat = parseDiffStat(DIFF);
    expect(stat.additions).toBe(3); // +new one, +new two, +added
    expect(stat.deletions).toBe(2); // -old line, -removed
    expect(stat.files).toBe(2); // two `diff --git` headers
  });

  it('falls back to +++ headers when there is no `diff --git`', () => {
    const stat = parseDiffStat('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    expect(stat.files).toBe(1);
    expect(stat.additions).toBe(1);
    expect(stat.deletions).toBe(1);
  });

  it('returns all-zero for an empty diff', () => {
    expect(parseDiffStat('')).toEqual({ additions: 0, deletions: 0, files: 0 });
  });

  it('counts body lines whose content starts with ++/-- (not header miscount)', () => {
    // Inside the hunk: `+++counter;` is an ADDED line `++counter;`, and
    // `---counter;` is a DELETED line `--counter;` — not file headers.
    const diff = [
      'diff --git a/c.ts b/c.ts',
      '--- a/c.ts',
      '+++ b/c.ts',
      '@@ -1,2 +1,2 @@',
      '---counter;',
      '+++counter;',
    ].join('\n');
    const stat = parseDiffStat(diff);
    expect(stat.additions).toBe(1);
    expect(stat.deletions).toBe(1);
    expect(stat.files).toBe(1);
  });
});

describe('formatDiffStat', () => {
  it('formats with singular/plural file labels', () => {
    expect(formatDiffStat({ additions: 24, deletions: 6, files: 2 })).toBe('+24 −6 · 2 files');
    expect(formatDiffStat({ additions: 1, deletions: 0, files: 1 })).toBe('+1 −0 · 1 file');
  });
  it('is empty for a no-op stat', () => {
    expect(formatDiffStat({ additions: 0, deletions: 0, files: 0 })).toBe('');
  });
});
