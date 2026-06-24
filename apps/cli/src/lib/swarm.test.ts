import { describe, expect, it } from 'vitest';
import {
  asAllocationSubtasks,
  chooseBuildShape,
  holdWhilePaused,
  parseFirstJsonObject,
  type SwarmSubtask,
} from './swarm';

describe('holdWhilePaused (AO6 Pillar 3 — the pause gate loop)', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('returns immediately and never fires onPause when not paused', async () => {
    let paused = 0;
    let resumed = 0;
    await holdWhilePaused({
      isPaused: () => false,
      isAborted: () => false,
      sleep: noSleep,
      pollMs: 0,
      onPause: () => (paused += 1),
      onResume: () => (resumed += 1),
    });
    expect(paused).toBe(0);
    expect(resumed).toBe(0);
  });

  it('HOLDS while paused then resumes when the flag clears (onPause/onResume once)', async () => {
    let ticks = 0;
    let paused = 0;
    let resumed = 0;
    await holdWhilePaused({
      // paused for the first 3 polls, then cleared.
      isPaused: () => ticks < 3,
      isAborted: () => false,
      sleep: () => {
        ticks += 1;
        return Promise.resolve();
      },
      pollMs: 0,
      onPause: () => (paused += 1),
      onResume: () => (resumed += 1),
    });
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
    expect(ticks).toBeGreaterThanOrEqual(3); // it actually held across polls
  });

  it('breaks the hold immediately when aborted (cancel beats pause)', async () => {
    let resumed = 0;
    await holdWhilePaused({
      isPaused: () => true, // would hold forever…
      isAborted: () => true, // …but a cancel is in effect
      sleep: noSleep,
      pollMs: 0,
      onPause: () => {
        throw new Error('must not pause when already aborted');
      },
      onResume: () => (resumed += 1),
    });
    expect(resumed).toBe(0);
  });
});

describe('chooseBuildShape (AO2 auto-orchestration decision)', () => {
  it('parallelizes a build with ≥2 independent subtasks in a git repo', () => {
    expect(chooseBuildShape({ isRepo: true, subtaskCount: 2 })).toBe('swarm');
    expect(chooseBuildShape({ isRepo: true, subtaskCount: 5 })).toBe('swarm');
  });

  it('runs sequentially when the task decomposed to a single workstream', () => {
    expect(chooseBuildShape({ isRepo: true, subtaskCount: 1 })).toBe('sequential');
    expect(chooseBuildShape({ isRepo: true, subtaskCount: 0 })).toBe('sequential');
  });

  it('never parallelizes outside a git repo (lanes need isolated worktrees)', () => {
    expect(chooseBuildShape({ isRepo: false, subtaskCount: 4 })).toBe('sequential');
    expect(chooseBuildShape({ isRepo: false, subtaskCount: 1 })).toBe('sequential');
  });
});

describe('parseFirstJsonObject (AO3b balanced-brace hardening)', () => {
  it('parses a clean JSON object', () => {
    expect(parseFirstJsonObject('{"subtasks":[]}')).toEqual({ subtasks: [] });
  });

  it('extracts the object from fenced output with trailing prose', () => {
    const out = 'Here you go:\n```json\n{"a":1,"b":{"c":2}}\n```\nHope that helps!';
    expect(parseFirstJsonObject(out)).toEqual({ a: 1, b: { c: 2 } });
  });

  it('stops at the first balanced object and ignores trailing junk that broke the greedy regex', () => {
    // A greedy /\{[\s\S]*\}/ would over-capture through the second brace block and fail.
    expect(parseFirstJsonObject('{"ok":true}\n\nNOTE: {not: valid json}')).toEqual({ ok: true });
  });

  it('handles braces inside strings without miscounting depth', () => {
    expect(parseFirstJsonObject('{"instruction":"use a regex like {2,3} here"}')).toEqual({
      instruction: 'use a regex like {2,3} here',
    });
  });

  it('returns null when there is no object', () => {
    expect(parseFirstJsonObject('no json here')).toBeNull();
    expect(parseFirstJsonObject('')).toBeNull();
  });
});

describe('asAllocationSubtasks', () => {
  it('maps decomposed subtasks to the allocator id/title pairs', () => {
    const subtasks: SwarmSubtask[] = [
      { id: 't1', title: 'Add the route', instruction: 'do A' },
      { id: 't2', title: 'Add the test', instruction: 'do B' },
    ];
    expect(asAllocationSubtasks(subtasks)).toEqual([
      { id: 't1', title: 'Add the route' },
      { id: 't2', title: 'Add the test' },
    ]);
  });
});
