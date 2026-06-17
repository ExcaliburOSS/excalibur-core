import { describe, expect, it } from 'vitest';
import { estimateRun } from './estimate';
import { RunManager } from '../runs/run-manager';
import { makeTempDir, removeDir } from '../test-utils';

describe('estimateRun', () => {
  it('falls back to a per-task-type heuristic on a cold start (no history)', () => {
    const repoRoot = makeTempDir();
    try {
      const est = estimateRun(repoRoot, { workflow: 'fast-fix', taskType: 'bugfix', affectedUnits: 2 });
      expect(est.basedOnRuns).toBe(0);
      expect(est.estCostCents).toBeGreaterThan(0);
      expect(est.estDurationMs).toBeGreaterThan(0);
      expect(est.blastRadius).toBe(2);
      // A feature is priced higher than a bugfix in the priors.
      const feat = estimateRun(repoRoot, { workflow: 'x', taskType: 'feature', affectedUnits: 1 });
      expect(feat.estCostCents).toBeGreaterThan(
        estimateRun(repoRoot, { workflow: 'x', taskType: 'bugfix', affectedUnits: 1 }).estCostCents,
      );
    } finally {
      removeDir(repoRoot);
    }
  });

  it('refines from the most recent completed same-workflow runs', () => {
    const repoRoot = makeTempDir();
    try {
      const manager = new RunManager(repoRoot);
      // Two completed fast-fix runs: cost 4c over ~10s, and 6c over ~20s → avg 5c / 15s.
      for (const [cost, startSec, endSec] of [
        [4, '2026-06-17T10:00:00.000Z', '2026-06-17T10:00:10.000Z'],
        [6, '2026-06-17T11:00:00.000Z', '2026-06-17T11:00:20.000Z'],
      ] as const) {
        const run = manager.createRun({
          title: 'fix',
          autonomyLevel: 3,
          workflow: 'fast-fix',
          model: 'kimi',
          executionStyle: 'fast',
        });
        manager.appendModelCall(run.id, {
          provider: 'kimi',
          model: 'k',
          inputTokens: 10,
          outputTokens: 5,
          costCents: cost,
          timestamp: startSec,
        });
        manager.updateRecord(run.id, { status: 'completed', startedAt: startSec, completedAt: endSec });
      }
      const est = estimateRun(repoRoot, { workflow: 'fast-fix', taskType: 'bugfix', affectedUnits: 1 });
      expect(est.basedOnRuns).toBe(2);
      expect(est.estCostCents).toBeCloseTo(5);
      expect(est.estDurationMs).toBeCloseTo(15_000);
    } finally {
      removeDir(repoRoot);
    }
  });

  it('selects the most-recently-COMPLETED runs, not the most-recently-started', () => {
    const repoRoot = makeTempDir();
    try {
      const manager = new RunManager(repoRoot);
      // Created (started) in order A, B, C — but A COMPLETES last. With sampleSize
      // 2, completion-order selection must pick {A, C}, not start-order {B, C}.
      const mk = (cost: number, completedAt: string): void => {
        const run = manager.createRun({ title: 't', autonomyLevel: 3, workflow: 'fast-fix', executionStyle: 'fast' });
        manager.appendModelCall(run.id, { provider: 'k', model: 'k', inputTokens: 1, outputTokens: 1, costCents: cost, timestamp: completedAt });
        manager.updateRecord(run.id, { status: 'completed', completedAt });
      };
      mk(100, '2026-06-17T13:00:00.000Z'); // A — started first, completed LAST
      mk(2, '2026-06-17T11:10:00.000Z'); // B — completed earliest
      mk(4, '2026-06-17T12:05:00.000Z'); // C
      const est = estimateRun(repoRoot, { workflow: 'fast-fix', taskType: 'bugfix', affectedUnits: 1, sampleSize: 2 });
      expect(est.basedOnRuns).toBe(2);
      expect(est.estCostCents).toBeCloseTo(52); // (A 100 + C 4) / 2, NOT (B 2 + C 4)/2 = 3
    } finally {
      removeDir(repoRoot);
    }
  });

  it('ignores runs of other workflows + non-completed runs', () => {
    const repoRoot = makeTempDir();
    try {
      const manager = new RunManager(repoRoot);
      const a = manager.createRun({ title: 'a', autonomyLevel: 3, workflow: 'structured-feature', executionStyle: 'structured' });
      manager.updateRecord(a.id, { status: 'completed', completedAt: '2026-06-17T10:00:05.000Z' });
      const b = manager.createRun({ title: 'b', autonomyLevel: 3, workflow: 'fast-fix', executionStyle: 'fast' });
      manager.updateRecord(b.id, { status: 'failed' }); // not completed
      // No completed fast-fix runs → cold-start heuristic.
      expect(estimateRun(repoRoot, { workflow: 'fast-fix', taskType: 'bugfix', affectedUnits: 1 }).basedOnRuns).toBe(0);
    } finally {
      removeDir(repoRoot);
    }
  });
});
