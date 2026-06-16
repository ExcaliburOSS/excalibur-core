import { describe, expect, it } from 'vitest';
import { runIntervalLoop } from './interval-loop';

describe('runIntervalLoop', () => {
  it('runs `times` iterations and reports completed (no-op sleep)', async () => {
    const runs: number[] = [];
    const result = await runIntervalLoop({
      everySeconds: 0,
      times: 3,
      run: (i) => {
        runs.push(i);
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ status: 'completed', iterations: 3 });
    expect(runs).toEqual([1, 2, 3]);
  });

  it('waits `everySeconds` between iterations (only between, not after the last)', async () => {
    const sleeps: number[] = [];
    const result = await runIntervalLoop({
      everySeconds: 30,
      times: 3,
      run: () => Promise.resolve(),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.iterations).toBe(3);
    expect(sleeps).toEqual([30_000, 30_000]); // 2 waits for 3 iterations
  });

  it('stops early when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    let ran = 0;
    const result = await runIntervalLoop({
      everySeconds: 30,
      times: 5,
      signal: controller.signal,
      run: () => {
        ran += 1;
        return Promise.resolve();
      },
      // Abort during the wait after the first iteration.
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    expect(result.status).toBe('aborted');
    expect(ran).toBe(1);
  });

  it('does not run at all when already aborted', async () => {
    let ran = 0;
    const result = await runIntervalLoop({
      everySeconds: 0,
      times: 3,
      signal: AbortSignal.abort(),
      run: () => {
        ran += 1;
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ status: 'aborted', iterations: 0 });
    expect(ran).toBe(0);
  });
});
