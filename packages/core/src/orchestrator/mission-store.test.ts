import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findResumableMission,
  listMissions,
  loadMission,
  resumableMissions,
  saveMission,
} from './mission-store';
import { initMissionState } from './supervisor';
import type { Mission, OrchestrationPlan } from './types';

const mission: Mission = {
  goal: 'g',
  interpretation: 'g',
  complexity: 'medium',
  risk: 'low',
  successCriteria: ['ok'],
  needsClarification: false,
  needsUnderstanding: false,
  parallelizable: false,
};
const plan: OrchestrationPlan = {
  goal: 'g',
  steps: [{ id: 'i', capability: 'implement', objective: 'do', dependsOn: [], gate: false }],
  rationale: 'r',
};

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-mission-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('mission-store (M5 checkpoint/resume)', () => {
  it('round-trips a mission snapshot to disk', () => {
    const state = initMissionState(mission, plan, 'm1');
    state.spentCents = 42;
    saveMission(repo, state);
    const loaded = loadMission(repo, 'm1');
    expect(loaded?.id).toBe('m1');
    expect(loaded?.spentCents).toBe(42);
    expect(loaded?.steps[0]?.step.id).toBe('i');
  });

  it('returns null for a missing/unknown mission', () => {
    expect(loadMission(repo, 'nope')).toBeNull();
    expect(listMissions(repo)).toEqual([]);
  });

  it('lists checkpointed missions and filters the resumable (paused) ones', () => {
    const a = initMissionState(mission, plan, 'a');
    a.outcome = 'completed';
    a.done = true;
    const b = initMissionState(mission, plan, 'b');
    b.outcome = 'paused';
    b.pausedReason = 'budget';
    saveMission(repo, a);
    saveMission(repo, b);
    expect(listMissions(repo).sort()).toEqual(['a', 'b']);
    expect(resumableMissions(repo)).toEqual(['b']); // only the paused one
  });

  it('findResumableMission returns the newest UNFINISHED mission state (G3 resume offer)', () => {
    // A finished mission is never offered; an interrupted one (not done, not
    // paused) IS — resume must cover a crash/close, not only a budget pause.
    const finished = initMissionState(mission, plan, 'm_20260101');
    finished.outcome = 'completed';
    finished.done = true;
    const olderPaused = initMissionState(mission, plan, 'm_20260201');
    olderPaused.outcome = 'paused';
    const newerInterrupted = initMissionState(mission, plan, 'm_20260301');
    newerInterrupted.outcome = 'running'; // crashed mid-drive → not done → resumable
    saveMission(repo, finished);
    saveMission(repo, olderPaused);
    saveMission(repo, newerInterrupted);

    const found = findResumableMission(repo);
    expect(found?.id).toBe('m_20260301'); // newest not-done wins (crash-resume, not just paused)
    expect(found?.done).toBe(false);
  });

  it('findResumableMission returns null when every mission is finished', () => {
    const done = initMissionState(mission, plan, 'done1');
    done.done = true;
    done.outcome = 'completed';
    saveMission(repo, done);
    expect(findResumableMission(repo)).toBeNull();
  });
});
