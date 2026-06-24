import { describe, expect, it } from 'vitest';
import {
  blockThread,
  cycleForeground,
  drainBanners,
  fleetCounts,
  initialFleet,
  pruneSettled,
  settleThread,
  spawnThread,
} from './fleet';

describe('fleet (pure thread state machine)', () => {
  it('spawns running threads without stealing focus', () => {
    let f = initialFleet();
    f = spawnThread(f, 't1', 'refactor billing');
    f = spawnThread(f, 't2', 'write tests');
    expect(f.threads.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(f.threads.every((t) => t.status === 'running')).toBe(true);
    expect(f.foreground).toBe(-1); // stays on the main prompt
    expect(spawnThread(f, 't1', 'dup').threads).toHaveLength(2); // dedup by id
  });

  it('AO8-1: stores an optional follow-up on the thread (survives settle)', () => {
    let f = spawnThread(initialFleet(), 't1', 'build it', 'run the tests');
    expect(f.threads[0]?.followUp).toBe('run the tests');
    // The follow-up persists through settle (so the REPL can dispatch it on done).
    f = settleThread(f, 't1', 'done', 'done!');
    expect(f.threads[0]?.followUp).toBe('run the tests');
    // No follow-up by default / for an empty string.
    expect(spawnThread(initialFleet(), 't2', 'x').threads[0]?.followUp).toBeUndefined();
    expect(spawnThread(initialFleet(), 't3', 'x', '').threads[0]?.followUp).toBeUndefined();
  });

  it('auto-focuses a thread that becomes blocked (rule 1)', () => {
    let f = spawnThread(spawnThread(initialFleet(), 't1', 'a'), 't2', 'b');
    f = blockThread(f, 't2');
    expect(f.threads[1]?.status).toBe('blocked');
    expect(f.foreground).toBe(1); // focus stole to the blocked thread
  });

  it('settles with a one-shot banner and never steals focus; foreground falls back', () => {
    let f = spawnThread(initialFleet(), 't1', 'a');
    f = blockThread(f, 't1'); // foreground = 0
    f = settleThread(f, 't1', 'done', '✓ t1 done');
    expect(f.threads[0]?.status).toBe('done');
    expect(f.foreground).toBe(-1); // left the finished thread → back to prompt
    const drained = drainBanners(f);
    expect(drained.banners).toEqual(['✓ t1 done']);
    expect(drainBanners(drained.state).banners).toEqual([]); // one-shot
  });

  it('cycles focus across live threads + the prompt, preserving the leaving thread draft', () => {
    let f = spawnThread(spawnThread(initialFleet(), 't1', 'a'), 't2', 'b');
    expect(f.foreground).toBe(-1);
    f = cycleForeground(f, 'prompt draft'); // -1 → 0 (the prompt draft is the REPL's, not a thread's)
    expect(f.foreground).toBe(0);
    f = cycleForeground(f, 'draft on t1'); // 0 → 1: store t1's draft as we leave it
    expect(f.foreground).toBe(1);
    expect(f.threads[0]?.draft).toBe('draft on t1');
    f = cycleForeground(f, ''); // 1 → wrap to -1 (prompt)
    expect(f.foreground).toBe(-1);
  });

  it('counts active/blocked/done and prunes settled threads', () => {
    let f = spawnThread(spawnThread(spawnThread(initialFleet(), 't1', 'a'), 't2', 'b'), 't3', 'c');
    f = blockThread(f, 't2');
    f = settleThread(f, 't3', 'failed', '⚠ t3 failed');
    expect(fleetCounts(f)).toMatchObject({ running: 1, blocked: 1, failed: 1, active: 2 });
    f = pruneSettled(f);
    expect(f.threads.map((t) => t.id)).toEqual(['t1', 't2']); // t3 pruned
  });
});
