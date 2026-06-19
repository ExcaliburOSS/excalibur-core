import { describe, expect, it } from 'vitest';
import { aggregateInsights, type RunInsight } from './insights';

function run(partial: Partial<RunInsight> & Pick<RunInsight, 'id'>): RunInsight {
  return {
    status: 'completed',
    model: 'kimi',
    workflow: 'fast-fix',
    startedAt: '2026-06-15T10:00:00.000Z',
    costCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    filesChanged: 0,
    approvals: 0,
    verificationsBlocked: 0,
    ...partial,
  };
}

describe('aggregateInsights', () => {
  it('aggregates spend, tokens, status, and the completion rate', () => {
    const report = aggregateInsights([
      run({
        id: 'a',
        status: 'completed',
        costCents: 10,
        inputTokens: 100,
        outputTokens: 50,
        modelCalls: 2,
      }),
      run({
        id: 'b',
        status: 'failed',
        costCents: 6,
        inputTokens: 40,
        outputTokens: 20,
        modelCalls: 1,
      }),
      run({ id: 'c', status: 'cancelled', costCents: 0 }),
    ]);

    expect(report.totalRuns).toBe(3);
    expect(report.byStatus).toEqual({ completed: 1, failed: 1, cancelled: 1 });
    expect(report.totalCostCents).toBe(16);
    expect(report.totalInputTokens).toBe(140);
    expect(report.totalOutputTokens).toBe(70);
    expect(report.totalModelCalls).toBe(3);
    // 1 completed of 3 terminal.
    expect(report.completionRate).toBeCloseTo(1 / 3);
    expect(report.avgCostCentsPerRun).toBeCloseTo(16 / 3);
  });

  it('breaks down by model and workflow, sorted by spend descending', () => {
    const report = aggregateInsights([
      run({ id: 'a', model: 'kimi', workflow: 'fast-fix', costCents: 5 }),
      run({ id: 'b', model: 'groq', workflow: 'structured-feature', costCents: 20 }),
      run({ id: 'c', model: 'kimi', workflow: 'fast-fix', costCents: 5 }),
    ]);

    // kimi total = 5+5 = 10, groq total = 20 → groq sorts first (spend desc).
    expect(report.byModel.map((m) => m.key)).toEqual(['groq', 'kimi']);
    expect(report.byModel[0]?.key).toBe('groq');
    expect(report.byModel[0]?.costCents).toBe(20);
    const kimi = report.byModel.find((m) => m.key === 'kimi');
    expect(kimi?.runs).toBe(2);
    expect(kimi?.costCents).toBe(10);
    expect(report.byWorkflow.map((w) => w.key)).toContain('structured-feature');
  });

  it('buckets runs by day (chronological) for the trend', () => {
    const report = aggregateInsights([
      run({ id: 'a', startedAt: '2026-06-16T09:00:00.000Z', costCents: 3 }),
      run({ id: 'b', startedAt: '2026-06-15T09:00:00.000Z', costCents: 2 }),
      run({ id: 'c', startedAt: '2026-06-16T18:00:00.000Z', costCents: 4 }),
    ]);
    expect(report.byDay.map((d) => d.day)).toEqual(['2026-06-15', '2026-06-16']);
    expect(report.byDay[1]).toMatchObject({ day: '2026-06-16', runs: 2, costCents: 7 });
  });

  it('sums files changed, approvals and blocked verifications', () => {
    const report = aggregateInsights([
      run({ id: 'a', filesChanged: 3, approvals: 2, verificationsBlocked: 1 }),
      run({ id: 'b', filesChanged: 1, approvals: 0, verificationsBlocked: 0 }),
    ]);
    expect(report.totalFilesChanged).toBe(4);
    expect(report.totalApprovals).toBe(2);
    expect(report.totalVerificationsBlocked).toBe(1);
  });

  it('is empty-safe (no runs → zeros, not NaN)', () => {
    const report = aggregateInsights([]);
    expect(report.totalRuns).toBe(0);
    expect(report.completionRate).toBe(0);
    expect(report.avgCostCentsPerRun).toBe(0);
    expect(report.byModel).toEqual([]);
  });
});
