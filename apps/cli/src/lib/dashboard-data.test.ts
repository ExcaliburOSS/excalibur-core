import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  RunManager,
  SessionStore,
  ScheduleStore,
  savePlan,
  updatePlanStep,
  plansDir,
} from '@excalibur/core';
import { createEvent } from '@excalibur/shared';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import {
  buildBoard,
  buildOrchestrations,
  buildPlanDetail,
  buildPlans,
  buildSchedules,
  buildSessions,
  buildSessionDetail,
  buildThreads,
  buildWorkItemDetail,
} from './dashboard-data';
import { makeTempDir, removeDir } from '../test-utils';

describe('dashboard-data (store → DTO mappers)', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });
  afterEach(() => {
    removeDir(repoRoot);
  });

  it('maps shell sessions to summaries (newest-updated first) + a transcript (DASH1)', () => {
    const store = new SessionStore(repoRoot);
    const a = store.createSession({ title: 'older' });
    const b = store.createSession({ title: 'newer' });
    store.appendTurn(b.id, { role: 'user', kind: 'message', text: 'hi' });
    store.appendTurn(b.id, {
      role: 'assistant',
      kind: 'message',
      text: 'hello',
      model: 'kimi',
      costCents: 12,
    });

    const list = buildSessions(repoRoot);
    expect(list.map((s) => s.title)).toEqual(['newer', 'older']); // newer was updated last
    const newer = list.find((s) => s.id === b.id);
    expect(newer).toMatchObject({ turnCount: 2, status: 'active', lastModel: 'kimi' });
    void a;

    const detail = buildSessionDetail(repoRoot, b.id);
    expect(detail).not.toBeNull();
    expect(detail!.turns.map((t) => t.text)).toEqual(['hi', 'hello']);
    expect(detail!.turns[1]).toMatchObject({ role: 'assistant', model: 'kimi', costCents: 12 });
    // unknown id → null (never throws)
    expect(buildSessionDetail(repoRoot, 'sess_nope')).toBeNull();
  });

  it('surfaces only the `/bg` background fleet (conversation-bg runs) (DASH3)', () => {
    const manager = new RunManager(repoRoot);
    const bg = manager.createRun({
      title: 'bg: lint sweep',
      autonomyLevel: 3,
      workflow: 'conversation-bg',
    });
    manager.updateRecord(bg.id, { status: 'running' });
    manager.createRun({ title: 'a foreground chat', autonomyLevel: 3, workflow: 'conversation' });
    manager.createRun({ title: 'a build', autonomyLevel: 3, workflow: 'standard-feature' });

    const threads = buildThreads(repoRoot);
    expect(threads).toHaveLength(1); // only the conversation-bg run
    expect(threads[0]).toMatchObject({ id: bg.id, title: 'bg: lint sweep', status: 'running' });
  });

  it('maps scheduled jobs with a human cadence, soonest-next first (DASH2)', () => {
    const store = new ScheduleStore(repoRoot);
    store.add({
      id: 'sched_later',
      task: 'nightly coverage',
      spec: { type: 'dailyAt', minutesOfDay: 540 }, // 09:00
      createdAtMs: 1000,
      lastRunMs: null,
      nextRunMs: 5000,
      enabled: true,
    });
    store.add({
      id: 'sched_soon',
      task: 'lint sweep',
      spec: { type: 'interval', everyMs: 7_200_000 }, // every 2h
      createdAtMs: 1000,
      lastRunMs: 2000,
      nextRunMs: 3000,
      enabled: false,
    });
    const list = buildSchedules(repoRoot);
    expect(list.map((j) => j.id)).toEqual(['sched_soon', 'sched_later']); // sorted by nextRunMs
    expect(list[0]).toMatchObject({ task: 'lint sweep', enabled: false, lastRunMs: 2000 });
    expect(list[0]!.cadence.length).toBeGreaterThan(0); // describeSpec rendered a cadence
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

  it('maps a plan to structured progress + phases + resumable (PLAN3/PLAN4)', () => {
    const file = savePlan(repoRoot, {
      task: 'Ship the thing',
      planMarkdown: '## Setup\n1. Install\n2. Configure\n\n## Build\n1. Compile',
      status: 'approved',
      planRunId: 'run_p',
      now: new Date('2026-06-27T09:00:00.000Z'),
    });
    const id = file.slice(plansDir(repoRoot).length + 1, -'.md'.length);
    updatePlanStep(repoRoot, id, 'p1.s1', 'done', 'run_step1');

    // List summary carries the roll-up + resumable flag.
    const summary = buildPlans(repoRoot).find((p) => p.id === id);
    expect(summary?.progress).toEqual({ total: 3, done: 1 });
    expect(summary?.resumable).toBe(true);

    // Detail carries the phase/step tree, per-step status + run id, and next step.
    const detail = buildPlanDetail(repoRoot, id);
    expect(detail?.phases.map((p) => p.title)).toEqual(['Setup', 'Build']);
    expect(detail?.phases[0]?.steps[0]).toMatchObject({
      id: 'p1.s1',
      status: 'done',
      runId: 'run_step1',
    });
    expect(detail?.phases[0]?.steps[1]?.status).toBe('pending');
    expect(detail?.nextStepId).toBe('p1.s2');
    expect(detail?.body).toContain('Install');

    // An executed plan is not resumable.
    const done = savePlan(repoRoot, {
      task: 'Already shipped',
      planMarkdown: '1. only step',
      status: 'executed',
      planRunId: 'run_q',
      execRunId: 'run_e',
      now: new Date('2026-06-27T10:00:00.000Z'),
    });
    const doneId = done.slice(plansDir(repoRoot).length + 1, -'.md'.length);
    expect(buildPlans(repoRoot).find((p) => p.id === doneId)?.resumable).toBe(false);
  });
});
