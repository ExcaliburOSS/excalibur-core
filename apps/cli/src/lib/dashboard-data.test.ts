import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { RunManager } from '@excalibur/core';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import { buildBoard, buildWorkItemDetail } from './dashboard-data';
import { makeTempDir, removeDir } from '../test-utils';

describe('dashboard-data (store → DTO mappers)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });
  afterEach(() => {
    removeDir(repoRoot);
  });

  it('projects work items onto the five lanes with a run-count badge', () => {
    const provider = new LocalWorkItemProvider(repoRoot);
    const inProgress = provider.createWorkItem({
      title: 'Wire the board',
      status: 'in_progress',
      labels: ['dashboard'],
      assignee: 'rafa',
    });
    provider.createWorkItem({ title: 'Backlog idea', status: 'backlog' });

    // Link two runs to the in-progress item.
    const manager = new RunManager(repoRoot);
    for (const title of ['run A', 'run B']) {
      manager.createRun({
        title,
        autonomyLevel: 3,
        workflow: 'fast-fix',
        executionStyle: 'fast',
        workItemId: inProgress.key,
      });
    }

    const board = buildBoard(repoRoot);
    expect(board.lanes.map((l) => l.lane)).toEqual([
      'backlog',
      'todo',
      'in_progress',
      'review',
      'done',
    ]);
    const inProgressLane = board.lanes.find((l) => l.lane === 'in_progress');
    expect(inProgressLane?.items).toHaveLength(1);
    const card = inProgressLane?.items[0];
    expect(card?.key).toBe(inProgress.key);
    expect(card?.title).toBe('Wire the board');
    expect(card?.assignee).toBe('rafa');
    expect(card?.labels).toEqual(['dashboard']);
    expect(card?.runCount).toBe(2);
    expect(board.lanes.find((l) => l.lane === 'backlog')?.items).toHaveLength(1);
    expect(typeof board.generatedAt).toBe('string');
  });

  it('builds a work-item detail with its linked runs (cost rolled up)', async () => {
    const provider = new LocalWorkItemProvider(repoRoot);
    const item = provider.createWorkItem({ title: 'Ship D0', status: 'review' });

    const manager = new RunManager(repoRoot);
    const run = manager.createRun({
      title: 'implement D0',
      autonomyLevel: 3,
      workflow: 'agent-work',
      model: 'kimi',
      executionStyle: 'careful',
      workItemId: item.key,
    });
    manager.appendModelCall(run.id, {
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      inputTokens: 200,
      outputTokens: 80,
      costCents: 5,
      timestamp: new Date().toISOString(),
    });

    const detail = await buildWorkItemDetail(repoRoot, item.key);
    expect(detail).not.toBeNull();
    expect(detail?.key).toBe(item.key);
    expect(detail?.lane).toBe('review');
    expect(detail?.runs).toHaveLength(1);
    expect(detail?.runs[0]?.id).toBe(run.id);
    expect(detail?.runs[0]?.costCents).toBe(5);
    expect(detail?.runs[0]?.inputTokens).toBe(200);
    expect(detail?.runs[0]?.workItemId).toBe(item.key);
  });

  it('returns null for an unknown work item', async () => {
    expect(await buildWorkItemDetail(repoRoot, 'WI-999')).toBeNull();
  });
});
