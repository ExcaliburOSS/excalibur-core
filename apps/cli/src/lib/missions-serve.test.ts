import { initMissionState, saveMission, type MissionState } from '@excalibur/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { missionDetail, missionsList } from './missions-serve';
import type { Mission, OrchestrationPlan } from '@excalibur/core';

const mission: Mission = {
  goal: 'Add OAuth2 login',
  interpretation: 'third-party auth',
  complexity: 'large',
  risk: 'high',
  successCriteria: ['google works', 'tests pass'],
  needsClarification: false,
  needsUnderstanding: true,
  parallelizable: true,
};
const plan: OrchestrationPlan = {
  goal: mission.goal,
  steps: [
    { id: 'u', capability: 'understand', objective: 'map auth', dependsOn: [], gate: false },
    { id: 'i', capability: 'implement', objective: 'add it', dependsOn: ['u'], gate: false },
    { id: 't', capability: 'test', objective: 'run suite', dependsOn: ['i'], gate: true },
  ],
  rationale: 'r',
};

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-missions-serve-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function seed(id: string, mutate: (s: MissionState) => void): void {
  const state = initMissionState(mission, plan, id);
  mutate(state);
  saveMission(repo, state);
}

describe('missions-serve (dashboard data)', () => {
  it('lists missions with progress + outcome', () => {
    seed('m1', (s) => {
      s.steps[0]!.status = 'done';
      s.steps[1]!.status = 'done';
      s.spentCents = 30;
      s.outcome = 'paused';
    });
    seed('m2', (s) => {
      s.steps.forEach((st) => (st.status = 'done'));
      s.outcome = 'completed';
    });
    const list = missionsList(repo);
    expect(list).toHaveLength(2);
    const m1 = list.find((m) => m.id === 'm1')!;
    expect(m1.goal).toBe('Add OAuth2 login');
    expect(m1.stepsDone).toBe(2);
    expect(m1.stepsTotal).toBe(3);
    expect(m1.spentCents).toBe(30);
    expect(m1.outcome).toBe('paused');
    expect(list.find((m) => m.id === 'm2')!.stepsDone).toBe(3);
  });

  it('returns the full DAG for a mission detail', () => {
    seed('m1', (s) => {
      s.steps[0]!.status = 'done';
      s.steps[2]!.attempts = 2;
    });
    const detail = missionDetail(repo, 'm1')!;
    expect(detail.goal).toBe('Add OAuth2 login');
    expect(detail.risk).toBe('high');
    expect(detail.successCriteria).toHaveLength(2);
    expect(detail.steps.map((s) => `${s.capability}:${s.status}`)).toEqual([
      'understand:done',
      'implement:pending',
      'test:pending',
    ]);
    // The DAG edges + gate + retry survive the projection.
    expect(detail.steps.find((s) => s.id === 'i')?.dependsOn).toEqual(['u']);
    expect(detail.steps.find((s) => s.id === 't')?.gate).toBe(true);
    expect(detail.steps.find((s) => s.id === 't')?.attempts).toBe(2);
  });

  it('returns null for an unknown mission and [] when none exist', () => {
    expect(missionDetail(repo, 'nope')).toBeNull();
    expect(missionsList(repo)).toEqual([]);
  });
});
