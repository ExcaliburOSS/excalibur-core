import { describe, expect, it } from 'vitest';
import { capTotalAgents, chooseConcurrency, SWARM_MAX_TOTAL_AGENTS } from './concurrency';

describe('chooseConcurrency (AO3a governor, pure)', () => {
  it('never exceeds the lane count', () => {
    expect(chooseConcurrency({ laneCount: 2, cpuCount: 32 })).toBe(2);
    expect(chooseConcurrency({ laneCount: 1, cpuCount: 32 })).toBe(1);
  });

  it('leaves one core for the main process (cpu headroom)', () => {
    expect(chooseConcurrency({ laneCount: 100, cpuCount: 8 })).toBe(7);
    expect(chooseConcurrency({ laneCount: 100, cpuCount: 2 })).toBe(1);
  });

  it('always allows at least one worker, even on a single-core box', () => {
    expect(chooseConcurrency({ laneCount: 4, cpuCount: 1 })).toBe(1);
    expect(chooseConcurrency({ laneCount: 4, cpuCount: 0 })).toBe(1);
  });

  it('caps by how many lanes the remaining budget can fund', () => {
    // 200c budget, 80c/lane → only 2 affordable, even with plenty of cores+lanes.
    expect(
      chooseConcurrency({
        laneCount: 8,
        cpuCount: 32,
        remainingBudgetCents: 200,
        perLaneCostEstimateCents: 80,
      }),
    ).toBe(2);
  });

  it('ignores the budget cap when the per-lane estimate is unknown or zero', () => {
    expect(chooseConcurrency({ laneCount: 4, cpuCount: 32, remainingBudgetCents: 10 })).toBe(4);
    expect(
      chooseConcurrency({
        laneCount: 4,
        cpuCount: 32,
        remainingBudgetCents: 10,
        perLaneCostEstimateCents: 0,
      }),
    ).toBe(4);
  });

  it('respects an explicit hard cap', () => {
    expect(chooseConcurrency({ laneCount: 8, cpuCount: 32, hardCap: 3 })).toBe(3);
  });

  it('keeps at least one lane when the budget cannot fund even one', () => {
    expect(
      chooseConcurrency({
        laneCount: 4,
        cpuCount: 32,
        remainingBudgetCents: 10,
        perLaneCostEstimateCents: 80,
      }),
    ).toBe(1);
  });
});

describe('capTotalAgents (AO3a fail-closed backstop, pure)', () => {
  it('clamps the auto path to the default backstop', () => {
    expect(capTotalAgents(20)).toBe(SWARM_MAX_TOTAL_AGENTS);
    expect(capTotalAgents(3)).toBe(3);
  });

  it('honors a higher explicit ceiling (power-user --max-agents)', () => {
    expect(capTotalAgents(12, 16)).toBe(12);
    expect(capTotalAgents(20, 16)).toBe(16);
  });

  it('never returns below 1', () => {
    expect(capTotalAgents(0)).toBe(1);
    expect(capTotalAgents(-5)).toBe(1);
  });
});
