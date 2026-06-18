import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry';

const alwaysRetryable = (): boolean => true;

describe('withRetry', () => {
  it('returns the result on first success without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const result = await withRetry(async () => 'ok', {
      isRetryable: alwaysRetryable,
      sleep,
    });
    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('succeeds after one retry on a retryable failure', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('transient');
        }
        return 'recovered';
      },
      { isRetryable: alwaysRetryable, sleep, random: () => 0.5 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting maxRetries', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`fail-${calls}`);
        },
        { maxRetries: 2, isRetryable: alwaysRetryable, sleep, random: () => 0 },
      ),
    ).rejects.toThrow('fail-3');
    // 1 initial + 2 retries = 3 attempts.
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable failure', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('fatal');
        },
        { isRetryable: () => false, sleep },
      ),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses full jitter: delay = random() * min(maxDelay, base * 2^attempt)', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls <= 2) {
          throw new Error('retry');
        }
        return 'done';
      },
      {
        isRetryable: alwaysRetryable,
        baseDelayMs: 500,
        maxDelayMs: 8000,
        random: () => 0.5,
        sleep,
      },
    );
    // attempt 0: 0.5 * min(8000, 500) = 250; attempt 1: 0.5 * min(8000, 1000) = 500
    expect(delays).toEqual([250, 500]);
  });

  it('honors a server-supplied retryAfterMs capped at maxDelayMs', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('rate limited');
        }
        return 'ok';
      },
      {
        isRetryable: alwaysRetryable,
        maxDelayMs: 1000,
        retryAfterMs: () => 5000,
        random: () => 0.1,
        sleep,
      },
    );
    // Server asked for 5000ms but the ceiling caps it at 1000ms.
    expect(delays).toEqual([1000]);
  });

  it('adds jitter within the headroom above a server retryAfterMs below maxDelayMs', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('rate limited');
        }
        return 'ok';
      },
      {
        isRetryable: alwaysRetryable,
        maxDelayMs: 8000,
        retryAfterMs: () => 2000,
        random: () => 0.5, // half of the (8000 - 2000) headroom = +3000
        sleep,
      },
    );
    // Floor 2000 (server) + 0.5 * 6000 headroom = 5000 — spreads concurrent clients.
    expect(delays).toEqual([5000]);
  });
});
