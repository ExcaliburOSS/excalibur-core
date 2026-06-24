import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { RunManager } from '@excalibur/core';
import { createEvent } from '@excalibur/shared';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import { buildBoard, buildOrchestrations, buildWorkItemDetail } from './dashboard-data';
import { makeTempDir, removeDir } from '../test-utils';

describe('dashboard-data (store → DTO mappers)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });
  afterEach(() => {
    removeDir(repoRoot);
  });

  it('groups parent + child runs into a parallel orchestration (AO4e)', () => {
    const manager = new RunManager(repoRoot);
    const parent = manager.createRun({
      title: 'swarm: 2 lanes',
      autonomyLevel: 3,
      workflow: 'swarm',
    });
    manager.updateRecord(parent.id, { status: 'completed' });
    const a = manager.createRun({
      title: 'lane A',
      autonomyLevel: 3,
      workflow: 'swarm-lane',
      parentRunId: parent.id,
    });
    manager.updateRecord(a.id, { status: 'completed' });
    const b = manager.createRun({
      title: 'lane B',
      autonomyLevel: 3,
      workflow: 'swarm-lane',
      parentRunId: parent.id,
    });
    manager.updateRecord(b.id, { status: 'failed' });
    // An unrelated standalone run must NOT appear as an orchestration.
    manager.createRun({ title: 'solo', autonomyLevel: 1, workflow: 'fast-fix' });

    const orchestrations = buildOrchestrations(repoRoot);
    expect(orchestrations).toHaveLength(1);
    const o = orchestrations[0]!;
    expect(o.parentRunId).toBe(parent.id);
    expect(o.title).toBe('swarm: 2 lanes');
    expect(o.laneCount).toBe(2);
    expect(o.lanes.map((l) => l.title)).toEqual(['lane A', 'lane B']);
    expect(o.lanes.map((l) => l.status)).toEqual(['completed', 'failed']);
    // AO4e-3 — lanes with no work item project null (not undefined/missing).
    expect(o.lanes.map((l) => l.workItemId)).toEqual([null, null]);
  });

  it('projects each lane child run work item id (AO4e-3)', () => {
    const manager = new RunManager(repoRoot);
    const parent = manager.createRun({
      title: 'swarm: 1 lane',
      autonomyLevel: 3,
      workflow: 'swarm',
      workItemId: 'WI-7',
    });
    const a = manager.createRun({
      title: 'lane A',
      autonomyLevel: 3,
      workflow: 'swarm-lane',
      parentRunId: parent.id,
      workItemId: 'WI-7',
    });
    manager.updateRecord(a.id, { status: 'running' });
    const o = buildOrchestrations(repoRoot)[0]!;
    expect(o.workItemId).toBe('WI-7'); // parent level (existing)
    expect(o.lanes[0]!.workItemId).toBe('WI-7'); // AO4e-3 — now per-lane too
  });

  it('returns no orchestrations when there is no parallel work', () => {
    const manager = new RunManager(repoRoot);
    manager.createRun({ title: 'plain', autonomyLevel: 1, workflow: 'fast-fix' });
    expect(buildOrchestrations(repoRoot)).toEqual([]);
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

  it('sanitizes script-bearing link URLs so a javascript: scheme never reaches the client', async () => {
    const provider = new LocalWorkItemProvider(repoRoot);
    const item = provider.createWorkItem({ title: 'Has links' });
    await provider.linkPullRequest({
      integrationId: 'local',
      externalIdOrKey: item.key,
      pullRequest: { provider: 'github', url: 'javascript:alert(document.cookie)', title: 'evil' },
    });
    await provider.linkPullRequest({
      integrationId: 'local',
      externalIdOrKey: item.key,
      pullRequest: { provider: 'github', url: 'https://github.com/x/y/pull/1', title: 'ok' },
    });
    const detail = await buildWorkItemDetail(repoRoot, item.key);
    const urls = detail?.links.map((l) => l.url) ?? [];
    expect(urls).toContain('https://github.com/x/y/pull/1'); // safe URL preserved
    expect(urls).not.toContain('javascript:alert(document.cookie)'); // neutralized
    expect(urls.some((u) => u.startsWith('javascript:'))).toBe(false);
  });

  it("surfaces the active run's live checklist on the in-progress card (D1)", () => {
    const provider = new LocalWorkItemProvider(repoRoot);
    const item = provider.createWorkItem({ title: 'Live work', status: 'in_progress' });

    const manager = new RunManager(repoRoot);
    const run = manager.createRun({
      title: 'driving',
      autonomyLevel: 3,
      workflow: 'agent-work',
      executionStyle: 'careful',
      workItemId: item.key,
    });
    manager.updateRecord(run.id, { status: 'running' }); // in flight
    // Two checklist snapshots — the LATEST must win.
    manager.appendEvent(
      run.id,
      createEvent({
        runId: run.id,
        type: 'task_update',
        payload: { tasks: [{ id: 't1', text: 'old', status: 'pending' }] },
      }),
    );
    manager.appendEvent(
      run.id,
      createEvent({
        runId: run.id,
        type: 'task_update',
        payload: {
          tasks: [
            { id: 't1', text: 'analyze', status: 'completed' },
            { id: 't2', text: 'implement', status: 'in_progress' },
            { id: 't3', text: 'test', status: 'pending' },
          ],
        },
      }),
    );

    const card = buildBoard(repoRoot)
      .lanes.find((l) => l.lane === 'in_progress')
      ?.items.find((i) => i.key === item.key);
    expect(card?.activeRunId).toBe(run.id);
    expect(card?.checklist.map((c) => c.text)).toEqual(['analyze', 'implement', 'test']);
    expect(card?.checklist.filter((c) => c.status === 'completed')).toHaveLength(1);
  });

  it('surfaces the NEWEST active run on the board when several are in flight', () => {
    const provider = new LocalWorkItemProvider(repoRoot);
    const item = provider.createWorkItem({ title: 'Re-run', status: 'in_progress' });
    const manager = new RunManager(repoRoot);

    const older = manager.createRun({
      title: 'older',
      autonomyLevel: 3,
      workflow: 'agent-work',
      executionStyle: 'careful',
      workItemId: item.key,
    });
    manager.updateRecord(older.id, { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' });
    manager.appendEvent(
      older.id,
      createEvent({
        runId: older.id,
        type: 'task_update',
        payload: { tasks: [{ id: 'o', text: 'old run task', status: 'in_progress' }] },
      }),
    );

    const newer = manager.createRun({
      title: 'newer',
      autonomyLevel: 3,
      workflow: 'agent-work',
      executionStyle: 'careful',
      workItemId: item.key,
    });
    manager.updateRecord(newer.id, { status: 'running', startedAt: '2026-02-01T00:00:00.000Z' });
    manager.appendEvent(
      newer.id,
      createEvent({
        runId: newer.id,
        type: 'task_update',
        payload: { tasks: [{ id: 'n', text: 'new run task', status: 'in_progress' }] },
      }),
    );

    const card = buildBoard(repoRoot)
      .lanes.find((l) => l.lane === 'in_progress')
      ?.items.find((i) => i.key === item.key);
    // The board must reflect the most recent run, not whatever listRuns yields first.
    expect(card?.activeRunId).toBe(newer.id);
    expect(card?.checklist.map((c) => c.text)).toEqual(['new run task']);
  });

  it('shows no checklist when the run is finished (not active)', () => {
    const provider = new LocalWorkItemProvider(repoRoot);
    const item = provider.createWorkItem({ title: 'Done work', status: 'done' });
    const manager = new RunManager(repoRoot);
    const run = manager.createRun({
      title: 'finished',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      executionStyle: 'fast',
      workItemId: item.key,
    });
    manager.updateRecord(run.id, { status: 'completed' });
    manager.appendEvent(
      run.id,
      createEvent({
        runId: run.id,
        type: 'task_update',
        payload: { tasks: [{ id: 't1', text: 'x', status: 'completed' }] },
      }),
    );
    const card = buildBoard(repoRoot)
      .lanes.find((l) => l.lane === 'done')
      ?.items.find((i) => i.key === item.key);
    expect(card?.activeRunId).toBeNull();
    expect(card?.checklist).toEqual([]);
  });
});
