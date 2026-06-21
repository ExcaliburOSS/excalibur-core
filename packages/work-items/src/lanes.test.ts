import { describe, expect, it } from 'vitest';
import { isWorkItemLane, laneOf, WORK_ITEM_LANES } from './lanes';

describe('laneOf', () => {
  it('maps legacy/remote statuses onto canonical lanes', () => {
    expect(laneOf('open')).toBe('todo');
    expect(laneOf('new')).toBe('todo');
    expect(laneOf('closed')).toBe('done');
    expect(laneOf('completed')).toBe('done');
    expect(laneOf('merged')).toBe('done');
    expect(laneOf('in-progress')).toBe('in_progress');
    expect(laneOf('In Progress')).toBe('in_progress');
    expect(laneOf('in_review')).toBe('review');
    expect(laneOf('backlog')).toBe('backlog');
    expect(laneOf(null)).toBe('todo');
    expect(laneOf('something-weird')).toBe('todo');
  });

  it('isWorkItemLane recognizes only canonical lanes', () => {
    expect(isWorkItemLane('in_progress')).toBe(true);
    expect(isWorkItemLane('done')).toBe(true);
    expect(isWorkItemLane('open')).toBe(false);
  });

  it('has the five canonical lanes', () => {
    expect(WORK_ITEM_LANES).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
  });
});
