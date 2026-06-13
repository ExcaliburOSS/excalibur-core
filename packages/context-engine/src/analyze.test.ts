import { afterEach, describe, expect, it } from 'vitest';
import { isExcaliburError } from '@excalibur/shared';
import { analyzeRepository } from './analyze';
import { RepoAnalysisError } from './errors';
import { makeFixtureDir, removeFixtureDir } from './test-utils';

describe('analyzeRepository', () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(removeFixtureDir));
  });

  it('throws a RepoAnalysisError (ExcaliburError) for a missing directory', async () => {
    const error = await analyzeRepository('/nonexistent/excalibur/repo').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RepoAnalysisError);
    expect(isExcaliburError(error)).toBe(true);
    if (isExcaliburError(error)) {
      expect(error.code).toBe('repo_analysis');
    }
  });

  it('analyzes an empty repository with safe defaults', async () => {
    const dir = await makeFixtureDir({ 'notes.txt': 'hello' });
    fixtures.push(dir);

    const analysis = await analyzeRepository(dir);
    expect(analysis.root).toBe(dir);
    expect(analysis.languages).toEqual([]);
    expect(analysis.frameworks).toEqual([]);
    expect(analysis.packageManager).toBeNull();
    expect(analysis.commands).toEqual({});
    expect(analysis.instructionFiles).toEqual([]);
    expect(analysis.instructionSources).toEqual([]);
    expect(analysis.skills).toEqual([]);
    expect(analysis.suggestedWorkflows.length).toBeGreaterThan(0);
  });

  it('keeps user-global scanning off by default, on by explicit opt-in', async () => {
    const dir = await makeFixtureDir({ 'README.md': '# Demo' });
    const homeDir = await makeFixtureDir({ '.claude/CLAUDE.md': '# Personal' });
    fixtures.push(dir, homeDir);

    const defaultAnalysis = await analyzeRepository(dir, { homeDir });
    expect(defaultAnalysis.instructionSources.every((s) => s.scope === 'project')).toBe(true);

    const optIn = await analyzeRepository(dir, { homeDir, includeUserGlobal: true });
    expect(optIn.instructionSources.some((s) => s.scope === 'user_global')).toBe(true);
  });
});
