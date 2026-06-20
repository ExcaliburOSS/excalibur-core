import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@excalibur/core';
import { memorySeed, pathsFromText } from './agent-turn';
import { makeTempRepo, removeDir } from '../test-utils';

describe('pathsFromText', () => {
  it('extracts path-like tokens from a task line', () => {
    const paths = pathsFromText('please fix the bug in src/billing/charge.ts and update README.md');
    expect(paths).toContain('src/billing/charge.ts');
    expect(paths).toContain('README.md');
  });

  it('returns nothing for a path-less question', () => {
    expect(pathsFromText('how does the billing flow work?')).toEqual([]);
  });
});

describe('memorySeed (knowledge-compounding read side)', () => {
  it('returns null when there is no relevant memory', () => {
    const repo = makeTempRepo();
    try {
      expect(memorySeed(repo, 'touch src/billing/charge.ts')).toBeNull();
    } finally {
      removeDir(repo);
    }
  });

  it('injects captured memory relevant to a path named in the task', () => {
    const repo = makeTempRepo();
    try {
      new MemoryStore(repo).capture({
        type: 'decision',
        statement: 'Charges are always idempotent via a request key',
        subjectPaths: ['src/billing/charge.ts'],
      });
      const seed = memorySeed(repo, 'add a refund path to src/billing/charge.ts');
      expect(seed).not.toBeNull();
      expect(seed?.role).toBe('system');
      expect(seed?.content).toContain('Charges are always idempotent');
    } finally {
      removeDir(repo);
    }
  });
});
