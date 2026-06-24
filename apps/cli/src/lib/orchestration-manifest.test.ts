import { describe, expect, it } from 'vitest';
import {
  buildOrchestrationManifest,
  laneSignature,
  manifestToSubtasks,
  planResume,
  type ManifestLaneOutcome,
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

describe('laneSignature (AO7-1, pure)', () => {
  it('is stable for the same content and changes when instruction/deps/role change', () => {
    const base = { instruction: 'do A', dependsOn: ['x', 'y'], role: 'builder' };
    expect(laneSignature(base)).toBe(laneSignature({ ...base, dependsOn: ['y', 'x'] })); // order-insensitive
    expect(laneSignature(base)).not.toBe(laneSignature({ ...base, instruction: 'do A!' }));
    expect(laneSignature(base)).not.toBe(laneSignature({ ...base, dependsOn: ['x'] }));
    expect(laneSignature(base)).not.toBe(laneSignature({ ...base, role: 'reviewer' }));
  });

  it('AO7 review #6 — also changes when when / maxAttempts / outputSchema are edited', () => {
    const base = { instruction: 'analyze' };
    expect(laneSignature(base)).not.toBe(laneSignature({ ...base, when: 'on_failure' }));
    expect(laneSignature(base)).not.toBe(laneSignature({ ...base, maxAttempts: 3 }));
    expect(laneSignature(base)).not.toBe(
      laneSignature({ ...base, outputSchema: { type: 'object' } }),
    );
  });
});

describe('AO7 review #1/#5 — manifest persists + restores per-step controls', () => {
  const roleSpec: SwarmSubtask[] = [
    { id: 't1', title: 'A', instruction: 'review', role: 'reviewer' },
    {
      id: 't2',
      title: 'B',
      instruction: 'build',
      dependsOn: ['t1'],
      when: 'on_failure',
      maxAttempts: 2,
    },
  ];
  const m = buildOrchestrationManifest({
    task: 't',
    parentRunId: 'r',
    createdAt: '2026-06-24T00:00:00.000Z',
    mode: 'staged',
    subtasks: roleSpec,
    waves: [['t1'], ['t2']],
    outcomes: [
      { id: 't1', outcome: 'done', costCents: 1 },
      { id: 't2', outcome: 'failed', costCents: null },
    ],
  });

  it('persists role/when/maxAttempts on the manifest lane and restores them', () => {
    expect(m.lanes[0]).toMatchObject({ id: 't1', role: 'reviewer' });
    expect(m.lanes[1]).toMatchObject({ when: 'on_failure', maxAttempts: 2 });
    const subs = manifestToSubtasks(m);
    expect(subs[0]).toMatchObject({ role: 'reviewer' });
    expect(subs[1]).toMatchObject({ when: 'on_failure', maxAttempts: 2 });
  });

  it('plain --resume REUSES a role-bearing done lane (no false signature mismatch)', () => {
    const plan = planResume(m);
    expect(plan.reusedIds).toEqual(['t1']); // t1 (done, role:reviewer) reused, not re-run
    expect(plan.rerun.map((s) => s.id)).toEqual(['t2']);
  });
});

describe('planResume (AO7-1 content-addressed resume, pure)', () => {
  const mk = (subs: SwarmSubtask[], outcomes: ManifestLaneOutcome[]): OrchestrationManifest =>
    buildOrchestrationManifest({
      task: 't',
      parentRunId: 'r',
      createdAt: '2026-06-24T00:00:00.000Z',
      mode: 'staged',
      subtasks: subs,
      waves: [subs.map((s) => s.id)],
      outcomes,
    });
  const chain: SwarmSubtask[] = [
    { id: 't1', title: 'A', instruction: 'do A' },
    { id: 't2', title: 'B', instruction: 'do B', dependsOn: ['t1'] },
  ];

  it('plain resume re-runs a failed lane AND its transitive dependents', () => {
    // t1 FAILED, t2 done-but-depends-on-t1 → BOTH must re-run (t2's input changed).
    const m = mk(chain, [
      { id: 't1', outcome: 'failed', costCents: null },
      { id: 't2', outcome: 'done', costCents: 1 },
    ]);
    const plan = planResume(m);
    expect(plan.rerun.map((s) => s.id)).toEqual(['t1', 't2']);
    expect(plan.reusedIds).toEqual([]);
  });

  it('plain resume reuses a done lane whose dependency also completed', () => {
    const m = mk(chain, [
      { id: 't1', outcome: 'done', costCents: 1 },
      { id: 't2', outcome: 'failed', costCents: null },
    ]);
    const plan = planResume(m);
    expect(plan.rerun.map((s) => s.id)).toEqual(['t2']); // t1 reused, t2 re-runs
    expect(plan.reusedIds).toEqual(['t1']);
  });

  it('edited-spec resume re-runs an EDITED step + its dependents, reuses the unchanged', () => {
    const m = mk(chain, [
      { id: 't1', outcome: 'done', costCents: 1 },
      { id: 't2', outcome: 'done', costCents: 1 },
    ]);
    // Re-run with t1's instruction edited → t1 (signature changed) + t2 (depends on t1) re-run.
    const edited: SwarmSubtask[] = [
      { id: 't1', title: 'A', instruction: 'do A DIFFERENTLY' },
      { id: 't2', title: 'B', instruction: 'do B', dependsOn: ['t1'] },
    ];
    const plan = planResume(m, edited);
    expect(plan.rerun.map((s) => s.id)).toEqual(['t1', 't2']);
    expect(plan.reusedIds).toEqual([]);
  });

  it('edited-spec resume with NO edits reuses every completed lane (full cache hit)', () => {
    const m = mk(chain, [
      { id: 't1', outcome: 'done', costCents: 1 },
      { id: 't2', outcome: 'done', costCents: 1 },
    ]);
    const plan = planResume(m, chain);
    expect(plan.rerun).toEqual([]);
    expect(plan.reusedIds).toEqual(['t1', 't2']);
  });
});
