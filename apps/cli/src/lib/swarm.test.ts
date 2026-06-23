import { describe, expect, it } from 'vitest';
import {
  asAllocationSubtasks,
  chooseBuildShape,
  parseFirstJsonObject,
  type SwarmSubtask,
} from './swarm';

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
