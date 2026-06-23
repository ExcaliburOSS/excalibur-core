import { describe, expect, it } from 'vitest';
import { asAllocationSubtasks, chooseBuildShape, type SwarmSubtask } from './swarm';

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
