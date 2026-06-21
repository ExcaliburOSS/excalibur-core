import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalWorkItemProvider } from './local-provider';

/** WK1: the native kanban CRUD + board on the file-based local store. */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wi-kanban-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('LocalWorkItemProvider — kanban CRUD', () => {
  it('assigns an ascending order within a lane on create', () => {
    const p = new LocalWorkItemProvider(repo);
    const a = p.createWorkItem({ title: 'a' });
    const b = p.createWorkItem({ title: 'b' });
    expect(a.order).toBe(0);
    expect(b.order).toBe(1);
  });

  it('createWorkItem records assignee + parent', () => {
    const p = new LocalWorkItemProvider(repo);
    const item = p.createWorkItem({ title: 'child', assignee: 'rafa', parentExternalId: 'WI-9' });
    expect(item.assignee?.name).toBe('rafa');
    expect(item.parentExternalId).toBe('WI-9');
  });

  it('updateWorkItem patches only the provided fields', () => {
    const p = new LocalWorkItemProvider(repo);
    const a = p.createWorkItem({ title: 'a', priority: 'low' });
    const updated = p.updateWorkItem(a.key, { title: 'a2', assignee: 'rafa', labels: ['x'] });
    expect(updated.title).toBe('a2');
    expect(updated.assignee?.name).toBe('rafa');
    expect(updated.labels).toEqual(['x']);
    expect(updated.priority).toBe('low'); // untouched
  });

  it('clears an assignee with null', () => {
    const p = new LocalWorkItemProvider(repo);
    const a = p.createWorkItem({ title: 'a', assignee: 'rafa' });
    expect(p.updateWorkItem(a.key, { assignee: null }).assignee).toBeNull();
  });

  it('deletes an item (idempotent-ish: false when already gone)', () => {
    const p = new LocalWorkItemProvider(repo);
    const a = p.createWorkItem({ title: 'a' });
    expect(p.deleteWorkItem(a.key)).toBe(true);
    expect(p.deleteWorkItem(a.key)).toBe(false);
  });

  it('moves an item to another lane and appends its order', () => {
    const p = new LocalWorkItemProvider(repo);
    const a = p.createWorkItem({ title: 'a' });
    const moved = p.moveWorkItem(a.key, { lane: 'in_progress' });
    expect(moved.status).toBe('in_progress');
    expect(moved.order).toBe(0);
  });

  it('builds a 5-lane board grouping items by lane in order', () => {
    const p = new LocalWorkItemProvider(repo);
    const a = p.createWorkItem({ title: 'a' }); // open -> todo lane
    const b = p.createWorkItem({ title: 'b' });
    p.moveWorkItem(b.key, { lane: 'done' });

    const board = p.board();
    expect(board.map((l) => l.lane)).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
    expect(board.find((l) => l.lane === 'todo')?.items.map((i) => i.key)).toEqual([a.key]);
    expect(board.find((l) => l.lane === 'done')?.items.map((i) => i.key)).toEqual([b.key]);
  });
});
