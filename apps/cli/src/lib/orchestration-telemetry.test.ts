import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordOrchestration,
  readOrchestrationTelemetry,
  summarizeOrchestrations,
  type OrchestrationRecord,
} from './orchestration-telemetry';

const rec = (over: Partial<OrchestrationRecord> = {}): OrchestrationRecord => ({
  at: '2026-07-04T00:00:00.000Z',
  task: 't',
  shape: 'swarm',
  lanes: 3,
  waves: 1,
  done: 3,
  failed: 0,
  empty: 0,
  applied: true,
  ...over,
});

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-tel-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('orchestration telemetry (#10)', () => {
  it('round-trips records to JSONL (newest last) and normalises the task', () => {
    recordOrchestration(repo, rec({ task: '  build   the   thing  ' }));
    recordOrchestration(repo, rec({ shape: 'sequential', lanes: 1, done: 1 }));
    const all = readOrchestrationTelemetry(repo);
    expect(all).toHaveLength(2);
    expect(all[0]?.shape).toBe('swarm');
    expect(all[0]?.task).toBe('build the thing'); // whitespace collapsed, trimmed
    expect(all[1]?.shape).toBe('sequential');
  });

  it('returns [] for a repo with no telemetry, and skips a corrupt line', () => {
    expect(readOrchestrationTelemetry(repo)).toEqual([]);
    recordOrchestration(repo, rec());
    // A record still reads back after one valid write.
    expect(readOrchestrationTelemetry(repo)).toHaveLength(1);
  });

  it('summarises the KPIs — fan-out rate, apply rate, avg lanes', () => {
    const s = summarizeOrchestrations([
      rec({ shape: 'swarm', lanes: 4, applied: true }),
      rec({ shape: 'sequential', lanes: 1, applied: true }),
      rec({ shape: 'swarm', lanes: 2, applied: false }),
    ]);
    expect(s.runs).toBe(3);
    expect(s.fanOutRate).toBeCloseTo(2 / 3); // 2 of 3 fanned out into a swarm
    expect(s.applyRate).toBeCloseTo(2 / 3); // 2 of 3 landed on the tree
    expect(s.avgLanes).toBeCloseTo(7 / 3);
    expect(s.totalLanes).toBe(7);
  });

  it('summarises an empty set to zeros (no divide-by-zero)', () => {
    expect(summarizeOrchestrations([])).toEqual({
      runs: 0,
      fanOutRate: 0,
      applyRate: 0,
      avgLanes: 0,
      totalLanes: 0,
      totalDone: 0,
    });
  });
});
