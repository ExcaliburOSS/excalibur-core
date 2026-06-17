import { savePlan } from '@excalibur/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

describe('excalibur plans', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempRepo();
  });
  afterEach(() => removeDir(repo));

  it('reports an empty state when there are no plans', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('plans');
    expect(cli.stdout()).toContain('No saved plans yet');
  });

  it('lists saved plans newest-first with status, date and task', async () => {
    savePlan(repo, {
      task: 'Refactor auth',
      planMarkdown: 'do it',
      status: 'executed',
      planRunId: 'run_a',
      now: new Date('2026-06-16T10:00:00.000Z'),
    });
    savePlan(repo, {
      task: 'Add caching layer',
      planMarkdown: 'do it too',
      status: 'approved',
      planRunId: 'run_b',
      now: new Date('2026-06-17T10:00:00.000Z'),
    });
    const cli = createTestCli({ cwd: repo });
    await cli.run('plans');
    const out = cli.stdout();
    expect(out).toContain('Saved plans (2)');
    expect(out).toContain('Refactor auth');
    expect(out).toContain('Add caching layer');
    expect(out).toContain('2026-06-17');
    // Newest (Add caching layer, 06-17) appears before the older one (06-16).
    expect(out.indexOf('Add caching layer')).toBeLessThan(out.indexOf('Refactor auth'));
  });
});
