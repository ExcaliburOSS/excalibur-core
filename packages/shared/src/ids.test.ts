import { describe, expect, it } from 'vitest';
import { generateId, generateRunId } from './ids';

describe('generateRunId', () => {
  it('formats a fixed date as run_YYYYMMDD_HHMMSS in local time', () => {
    // Construct via local-time constructor so the expectation is TZ-independent.
    const date = new Date(2026, 5, 12, 14, 30, 22);
    expect(generateRunId(date)).toBe('run_20260612_143022');
  });

  it('zero-pads months, days, hours, minutes and seconds', () => {
    const date = new Date(2026, 0, 5, 4, 7, 9);
    expect(generateRunId(date)).toBe('run_20260105_040709');
  });

  it('defaults to the current time', () => {
    const before = generateRunId(new Date());
    const generated = generateRunId();
    const after = generateRunId(new Date());
    expect(generated >= before).toBe(true);
    expect(generated <= after).toBe(true);
    expect(generated).toMatch(/^run_\d{8}_\d{6}$/);
  });

  it('sorts lexicographically by time', () => {
    const earlier = generateRunId(new Date(2026, 5, 12, 9, 59, 59));
    const later = generateRunId(new Date(2026, 5, 12, 10, 0, 0));
    expect(earlier < later).toBe(true);
  });
});

describe('generateId', () => {
  it('produces <prefix>_<uuid>', () => {
    const id = generateId('patch');
    expect(id).toMatch(/^patch_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('produces unique values across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId('evt')));
    expect(ids.size).toBe(100);
  });
});
