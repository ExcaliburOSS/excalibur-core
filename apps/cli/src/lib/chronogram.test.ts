import { describe, expect, it } from 'vitest';
import { buildChronogram, laneStateOf, type ChronogramLaneRun } from './chronogram';

describe('laneStateOf (AO6 Pillar 2, pure)', () => {
  it('a recorded final outcome wins over the live status', () => {
    expect(laneStateOf('completed', 'empty')).toBe('empty');
    expect(laneStateOf('completed', 'done')).toBe('done');
    expect(laneStateOf('running', 'failed')).toBe('failed');
  });
  it('maps the live child status when no outcome is known yet', () => {
    expect(laneStateOf('running')).toBe('running');
    expect(laneStateOf('waiting_approval')).toBe('running');
    expect(laneStateOf('completed')).toBe('done');
    expect(laneStateOf('failed')).toBe('failed');
    expect(laneStateOf('cancelled')).toBe('cancelled');
    expect(laneStateOf(null)).toBe('pending');
    expect(laneStateOf('unknown-status')).toBe('pending');
  });
});

describe('buildChronogram (AO6 Pillar 2, pure)', () => {
  const runs = new Map<string, ChronogramLaneRun>([
    [
      'run_a',
      {
        runId: 'run_a',
        status: 'completed',
        startedAt: '2026-06-24T00:00:00.000Z',
        completedAt: '2026-06-24T00:00:30.000Z',
        costCents: 12,
      },
    ],
    [
      'run_b',
      {
        runId: 'run_b',
        status: 'running',
        startedAt: '2026-06-24T00:00:31.000Z',
        completedAt: null,
        costCents: 4,
      },
    ],
  ]);

  it('joins the wave/DAG structure with live per-lane run facts', () => {
    const c = buildChronogram({
      parentRunId: 'run_parent',
      task: 'ship the thing',
      mode: 'staged',
      status: 'running',
      startedAt: '2026-06-24T00:00:00.000Z',
      completedAt: null,
      workItemId: 'WI-7',
      waves: [['t1'], ['t2']],
      lanes: [
        { id: 't1', title: 'A', instruction: 'do A', dependsOn: [], runId: 'run_a' },
        { id: 't2', title: 'B', instruction: 'do B', dependsOn: ['t1'], runId: 'run_b' },
        // a not-yet-dispatched lane (no child run): pending, wave 1.
        { id: 't3', title: 'C', instruction: 'do C', dependsOn: ['t1'], runId: null },
      ],
      runsById: runs,
    });

    expect(c.mode).toBe('staged');
    expect(c.waves).toEqual([['t1'], ['t2']]);
    const [a, b, cc] = c.lanes;
    // Wave assignment from the plan waves (t3 isn't in any wave → defaults to 0).
    expect(a?.wave).toBe(0);
    expect(b?.wave).toBe(1);
    expect(cc?.wave).toBe(0);
    // State derivation: completed→done, running→running, no run→pending.
    expect(a?.state).toBe('done');
    expect(b?.state).toBe('running');
    expect(cc?.state).toBe('pending');
    // Finished lane gets a duration; the live one stays null.
    expect(a?.durationMs).toBe(30_000);
    expect(b?.durationMs).toBeNull();
    // dependsOn (DAG edges) preserved.
    expect(b?.dependsOn).toEqual(['t1']);
    // Cost is summed across lanes that reported any.
    expect(c.totalCostCents).toBe(16);
    expect(cc?.costCents).toBeNull();
  });

  it('a final outcome refines a completed lane to empty (ran, no diff)', () => {
    const c = buildChronogram({
      parentRunId: 'run_parent',
      task: 't',
      mode: 'flat',
      status: 'completed',
      startedAt: '2026-06-24T00:00:00.000Z',
      completedAt: '2026-06-24T00:01:00.000Z',
      workItemId: null,
      waves: [['t1']],
      lanes: [{ id: 't1', title: 'A', instruction: 'do A', dependsOn: [], runId: 'run_a' }],
      outcomes: new Map([['t1', 'empty']]),
      runsById: runs,
    });
    expect(c.lanes[0]?.state).toBe('empty');
  });

  it('reports null total cost when no lane reported any cost', () => {
    const c = buildChronogram({
      parentRunId: 'p',
      task: 't',
      mode: 'flat',
      status: 'running',
      startedAt: '2026-06-24T00:00:00.000Z',
      completedAt: null,
      workItemId: null,
      waves: [['t1']],
      lanes: [{ id: 't1', title: 'A', instruction: '', dependsOn: [], runId: null }],
      runsById: new Map(),
    });
    expect(c.totalCostCents).toBeNull();
    expect(c.lanes[0]?.state).toBe('pending');
  });
});
