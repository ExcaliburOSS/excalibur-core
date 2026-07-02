import { SprintStore, listPlans, readPlan } from '@excalibur/core';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markAutoBuildStep, materializeAutoBuild, settleAutoBuild } from './auto-build-board';

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-board-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const NOW = new Date('2026-07-02T10:00:00');

const multi = [
  { id: 'a', title: 'Add API endpoint', instruction: 'Build the endpoint' },
  { id: 'b', title: 'Wire UI state', instruction: 'Wire it', dependsOn: ['a'] },
];

describe('materializeAutoBuild', () => {
  it('persists a plan, an epic + sub-tasks with dependency edges, and a rolling sprint', async () => {
    const board = materializeAutoBuild(repo, 'ship the feature', multi, {
      planRunId: 'turn_1',
      now: NOW,
    });
    expect(board).not.toBeNull();
    if (board === null) return;

    // Durable plan on disk, approved (resumable), with both steps.
    const stored = readPlan(repo, board.planId);
    expect(stored?.status).toBe('approved');
    expect(stored?.plan.phases[0]?.steps).toHaveLength(2);

    // Epic + one sub-task per lane, dependency edge mapped from dependsOn.
    expect(board.epicWorkItemId).not.toBeNull();
    const provider = new LocalWorkItemProvider(repo);
    const items = await provider.listWorkItems({ integrationId: 'local' });
    expect(items).toHaveLength(3); // epic + 2 steps
    const stepB = board.stepBySubtask.get('b');
    expect(stepB?.deps).toEqual(['p1.s1']);
    expect(stepB?.workItemId).toBeDefined();

    // A rolling weekly sprint exists, is active, and carries the STEP items only.
    const sprints = new SprintStore(repo).listSprints();
    expect(sprints).toHaveLength(1);
    expect(sprints[0]?.status).toBe('active');
    expect(board.sprintId).toBe(sprints[0]?.id);
    const inSprint = items.filter((i) => i.cycleOrSprint === board.sprintId);
    expect(inSprint).toHaveLength(2);
    expect(inSprint.every((i) => i.key !== board.epicWorkItemId)).toBe(true);
  });

  it('creates ONE plain card (no epic) for a single-lane build', async () => {
    const board = materializeAutoBuild(
      repo,
      'fix the typo',
      [{ id: 's1', title: 'fix the typo', instruction: 'fix it' }],
      { planRunId: 'turn_2', now: NOW },
    );
    expect(board).not.toBeNull();
    expect(board?.epicWorkItemId).toBeNull();
    const items = await new LocalWorkItemProvider(repo).listWorkItems({ integrationId: 'local' });
    expect(items).toHaveLength(1);
    expect(items[0]?.labels).toContain('build');
    expect(board?.stepBySubtask.get('s1')?.workItemId).toBe(items[0]?.key);
  });

  it('reuses the active sprint instead of creating a parallel one', () => {
    materializeAutoBuild(repo, 'first build', multi, { planRunId: 'turn_3', now: NOW });
    materializeAutoBuild(repo, 'second build', multi, { planRunId: 'turn_4', now: NOW });
    expect(new SprintStore(repo).listSprints()).toHaveLength(1);
  });

  it('returns null on empty subtasks and never throws', () => {
    expect(materializeAutoBuild(repo, 'noop', [], { planRunId: 'turn_5', now: NOW })).toBeNull();
  });
});

describe('markAutoBuildStep + settleAutoBuild', () => {
  it('live-syncs step status onto the plan checkpoint and the board lane', async () => {
    const board = materializeAutoBuild(repo, 'ship it', multi, { planRunId: 'turn_6', now: NOW });
    if (board === null) throw new Error('board expected');

    markAutoBuildStep(repo, board, 'a', 'active');
    const provider = new LocalWorkItemProvider(repo);
    const keyA = board.stepBySubtask.get('a')?.workItemId ?? '';
    expect(
      (await provider.getWorkItem({ integrationId: 'local', externalIdOrKey: keyA })).status,
    ).toBe('in_progress');

    settleAutoBuild(repo, board, 'ship it', {
      statusBySubtask: new Map([
        ['a', 'done'],
        ['b', 'done'],
      ]),
      fallback: 'pending',
    });
    expect(
      (await provider.getWorkItem({ integrationId: 'local', externalIdOrKey: keyA })).status,
    ).toBe('done');
    // Everything landed → the plan is promoted to executed.
    expect(readPlan(repo, board.planId)?.status).toBe('executed');
    // ...and PLAN6-for-auto-builds captured a decision memory for the task.
    const nodesFile = join(repo, '.excalibur', 'memory', 'nodes.jsonl');
    expect(existsSync(nodesFile)).toBe(true);
    expect(readFileSync(nodesFile, 'utf8')).toContain('ship it');
  });

  it('keeps the plan approved (resumable) when a lane blocked', () => {
    const board = materializeAutoBuild(repo, 'ship it', multi, { planRunId: 'turn_7', now: NOW });
    if (board === null) throw new Error('board expected');
    settleAutoBuild(repo, board, 'ship it', {
      statusBySubtask: new Map([
        ['a', 'done'],
        ['b', 'blocked'],
      ]),
      fallback: 'pending',
    });
    expect(readPlan(repo, board.planId)?.status).toBe('approved');
    expect(listPlans(repo)).toHaveLength(1);
  });
});
