import { describe, expect, it } from 'vitest';
import {
  buildOrchestrationManifest,
  manifestToSubtasks,
  type OrchestrationManifest,
} from './orchestration-manifest';
import type { SwarmSubtask } from './swarm';

const subtasks: SwarmSubtask[] = [
  { id: 't1', title: 'A', instruction: 'do A' },
  { id: 't2', title: 'B', instruction: 'do B', dependsOn: ['t1'] },
];

describe('buildOrchestrationManifest (AO5)', () => {
  it('captures lanes, dependsOn, waves and per-lane outcomes', () => {
    const m = buildOrchestrationManifest({
      task: 'build the thing',
      parentRunId: 'run_x',
      createdAt: '2026-06-24T00:00:00.000Z',
      mode: 'staged',
      subtasks,
      waves: [['t1'], ['t2']],
      outcomes: [
        { id: 't1', outcome: 'done', costCents: 5, runId: 'run_a' },
        { id: 't2', outcome: 'failed', costCents: null },
      ],
    });
    expect(m.version).toBe(1);
    expect(m.task).toBe('build the thing');
    expect(m.mode).toBe('staged');
    expect(m.waves).toEqual([['t1'], ['t2']]);
    expect(m.lanes).toHaveLength(2);
    expect(m.lanes[0]).toMatchObject({ id: 't1', outcome: 'done', costCents: 5, runId: 'run_a' });
    expect(m.lanes[1]).toMatchObject({ id: 't2', dependsOn: ['t1'], outcome: 'failed' });
  });

  it('defaults a lane with no recorded outcome to empty/null', () => {
    const m = buildOrchestrationManifest({
      task: 't',
      parentRunId: 'run_x',
      createdAt: '2026-06-24T00:00:00.000Z',
      mode: 'flat',
      subtasks: [{ id: 't1', title: 'A', instruction: 'do A' }],
      waves: [['t1']],
      outcomes: [],
    });
    expect(m.lanes[0]).toMatchObject({ outcome: 'empty', costCents: null });
    expect(m.lanes[0]?.runId).toBeUndefined();
  });
});

describe('manifestToSubtasks (AO5-3 re-run / resume, pure)', () => {
  const manifest: OrchestrationManifest = {
    version: 1,
    task: 't',
    mode: 'staged',
    parentRunId: 'run_x',
    createdAt: '2026-06-24T00:00:00.000Z',
    waves: [['t1'], ['t2']],
    lanes: [
      { id: 't1', title: 'A', instruction: 'do A', dependsOn: [], outcome: 'done', costCents: 5 },
      {
        id: 't2',
        title: 'B',
        instruction: 'do B',
        dependsOn: ['t1'],
        outcome: 'failed',
        costCents: null,
      },
    ],
  };

  it('re-run reconstructs ALL lanes with their instructions + deps', () => {
    const subs = manifestToSubtasks(manifest);
    expect(subs.map((s) => s.id)).toEqual(['t1', 't2']);
    expect(subs[1]).toMatchObject({ id: 't2', instruction: 'do B', dependsOn: ['t1'] });
  });

  it('resume drops the completed lanes and re-dispatches only the rest', () => {
    const subs = manifestToSubtasks(manifest, { resume: true });
    expect(subs.map((s) => s.id)).toEqual(['t2']); // t1 was done
  });
});
