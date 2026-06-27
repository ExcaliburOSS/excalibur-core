import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import { buildPlanMemoryEntry, planFilesTouched } from './plan-memory';
import type { StructuredPlan } from './plan-model';

function makePlan(over: Partial<StructuredPlan> = {}): StructuredPlan {
  return {
    version: 1,
    epicWorkItemId: 'WI-1',
    phases: [
      {
        id: 'p1',
        title: 'Setup',
        steps: [
          { id: 'p1.s1', title: 'Add config', status: 'done', runId: 'run_missing_1' },
          { id: 'p1.s2', title: 'Wire it up', status: 'done', runId: 'run_missing_2' },
        ],
      },
      {
        id: 'p2',
        title: 'Tests',
        steps: [{ id: 'p2.s1', title: 'Cover it', status: 'blocked' }],
      },
    ],
    ...over,
  };
}

describe('buildPlanMemoryEntry', () => {
  it('writes a completed-plan decision with an outcome statement + outline rationale', () => {
    const repo = makeTempDir();
    try {
      const entry = buildPlanMemoryEntry(repo, makePlan(), {
        task: 'Build the limiter',
        planRunId: 'run_plan',
        completed: true,
      });
      expect(entry.type).toBe('decision');
      expect(entry.statement).toContain('Build the limiter');
      expect(entry.statement).toContain('3 step'); // 3 steps total
      expect(entry.statement).toContain('2 phase');
      // Rationale carries the phase→step outline + the epic + status glyphs.
      expect(entry.rationale).toContain('Setup');
      expect(entry.rationale).toContain('✓Add config');
      expect(entry.rationale).toContain('Tracked as WI-1');
      expect(entry.confidence).toBe(0.8);
      expect(entry.sourceRunId).toBe('run_plan');
    } finally {
      removeDir(repo);
    }
  });

  it('writes a partial/blocked-plan memory with the blocked step + lower confidence', () => {
    const repo = makeTempDir();
    try {
      const entry = buildPlanMemoryEntry(repo, makePlan(), {
        task: 'Build the limiter',
        planRunId: 'run_plan',
        completed: false,
        blockedStepIds: ['p2.s1'],
      });
      expect(entry.statement).toContain('stopped at');
      expect(entry.statement).toContain('blocked on "Cover it"');
      expect(entry.rationale).toContain('Blocked: Cover it');
      expect(entry.confidence).toBe(0.6);
    } finally {
      removeDir(repo);
    }
  });

  it('omits subjectPaths when no run touched files (missing runs are skipped, never throws)', () => {
    const repo = makeTempDir();
    try {
      // The runIds point at non-existent runs → planFilesTouched returns [].
      expect(planFilesTouched(repo, makePlan())).toEqual([]);
      const entry = buildPlanMemoryEntry(repo, makePlan(), {
        task: 't',
        planRunId: 'r',
        completed: true,
      });
      expect(entry.subjectPaths).toBeUndefined();
    } finally {
      removeDir(repo);
    }
  });
});
