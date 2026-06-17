import { describe, expect, it } from 'vitest';
import {
  aggregateMesh,
  planVerificationMesh,
  type MeshVerdict,
} from './verification-mesh';

describe('planVerificationMesh (proportional)', () => {
  it('runs NO mesh for a docs change (and disables on mode:off)', () => {
    expect(planVerificationMesh({ taskType: 'docs', sensitive: false, autonomyLevel: 3 }).lenses).toEqual([]);
    expect(
      planVerificationMesh({ taskType: 'feature', sensitive: true, autonomyLevel: 4, mode: 'off' }).lenses,
    ).toEqual([]);
  });

  it('runs ONE correctness lens for a small low-risk bugfix', () => {
    const plan = planVerificationMesh({
      taskType: 'bugfix',
      sensitive: false,
      affectedUnits: 1,
      autonomyLevel: 1,
    });
    expect(plan.lenses).toEqual(['correctness']);
  });

  it('runs the FULL jury for a sensitive, high-autonomy, multi-module feature with tests', () => {
    const plan = planVerificationMesh({
      taskType: 'feature',
      sensitive: true,
      affectedUnits: 4,
      autonomyLevel: 4,
      hasTests: true,
    });
    expect(plan.lenses).toEqual(
      expect.arrayContaining(['correctness', 'security', 'regression', 'spec', 'reproduce']),
    );
    expect(plan.reason).toMatch(/sensitive paths|autonomy L4|modules/);
  });

  it('adds the security lens for a security task and regression for a refactor', () => {
    expect(planVerificationMesh({ taskType: 'security', sensitive: false, autonomyLevel: 3 }).lenses).toContain('security');
    expect(planVerificationMesh({ taskType: 'refactor', sensitive: false, autonomyLevel: 3 }).lenses).toContain('regression');
  });

  it('mode:always forces at least one lens even on a trivial change', () => {
    const plan = planVerificationMesh({
      taskType: 'docs',
      sensitive: false,
      autonomyLevel: 1,
      mode: 'always',
    });
    expect(plan.lenses.length).toBeGreaterThanOrEqual(1);
  });
});

describe('aggregateMesh', () => {
  const verdict = (over: Partial<MeshVerdict>): MeshVerdict => ({
    lens: 'correctness',
    issues: [],
    clean: true,
    ...over,
  });

  it('is clean (not blocked) when no lens found anything', () => {
    const res = aggregateMesh([verdict({ lens: 'correctness' }), verdict({ lens: 'security' })]);
    expect(res.blocked).toBe(false);
    expect(res.issues).toEqual([]);
    expect(res.summary).toMatch(/clean/);
  });

  it('BLOCKS when ANY lens reports a high-severity issue, and sorts high→low', () => {
    const res = aggregateMesh([
      verdict({ lens: 'correctness', clean: false, issues: [{ lens: 'correctness', severity: 'low', problem: 'nit' }] }),
      verdict({ lens: 'security', clean: false, issues: [{ lens: 'security', severity: 'high', problem: 'secret leak', fix: 'redact' }] }),
    ]);
    expect(res.blocked).toBe(true);
    expect(res.issues[0]?.severity).toBe('high');
    expect(res.summary).toMatch(/BLOCKING/);
  });

  it('does NOT block on medium/low-only issues', () => {
    const res = aggregateMesh([
      verdict({ lens: 'correctness', clean: false, issues: [{ lens: 'correctness', severity: 'medium', problem: 'meh' }] }),
    ]);
    expect(res.blocked).toBe(false);
    expect(res.issues).toHaveLength(1);
  });
});
