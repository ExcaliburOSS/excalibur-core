import { describe, expect, it } from 'vitest';
import type { DetectedStack, RepoPatterns } from './types';
import { suggestWorkflows } from './workflows';

const emptyPatterns: RepoPatterns = {
  hasBackend: false,
  hasFrontend: false,
  testDirs: [],
  migrationDirs: [],
  apiDirs: [],
  domainDirs: [],
  sensitivePaths: [],
};

const emptyStack: DetectedStack = { languages: [], frameworks: [], packageManager: null };

describe('suggestWorkflows', () => {
  it('is never empty, even for an empty repository', () => {
    const suggestions = suggestWorkflows(emptyStack, emptyPatterns);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions).toContain('fast-fix');
    expect(suggestions).toContain('standard-feature');
  });

  it('adds guarded workflows for risky patterns', () => {
    const suggestions = suggestWorkflows(emptyStack, {
      ...emptyPatterns,
      hasBackend: true,
      hasFrontend: true,
      testDirs: ['test'],
      migrationDirs: ['prisma/migrations'],
      sensitivePaths: ['src/auth'],
    });
    expect(suggestions).toEqual([
      'fast-fix',
      'standard-feature',
      'safe-refactor',
      'migration',
      'security-review',
      'structured-feature',
    ]);
  });
});
