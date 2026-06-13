import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTimeoutAbort, withTimeout } from './timeout';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts with the timeout reason once the timer fires', () => {
    const handle = withTimeout(1000);
    expect(handle.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(handle.signal.aborted).toBe(true);
    expect(isTimeoutAbort(handle.signal)).toBe(true);
    handle.clear();
  });

  it('does not fire after clear()', () => {
    const handle = withTimeout(1000);
    handle.clear();
    vi.advanceTimersByTime(5000);
    expect(handle.signal.aborted).toBe(false);
  });

  it('propagates a caller abort (not flagged as a timeout)', () => {
    const controller = new AbortController();
    const handle = withTimeout(1000, controller.signal);
    controller.abort(new Error('caller cancelled'));
    expect(handle.signal.aborted).toBe(true);
    expect(isTimeoutAbort(handle.signal)).toBe(false);
    handle.clear();
  });

  it('aborts immediately when the caller signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const handle = withTimeout(1000, controller.signal);
    expect(handle.signal.aborted).toBe(true);
    expect(isTimeoutAbort(handle.signal)).toBe(false);
    handle.clear();
  });
});

describe('isTimeoutAbort', () => {
  it('returns false for an undefined or non-aborted signal', () => {
    expect(isTimeoutAbort(undefined)).toBe(false);
    expect(isTimeoutAbort(new AbortController().signal)).toBe(false);
  });
});
