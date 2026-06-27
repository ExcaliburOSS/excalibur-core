import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import { SprintStore } from './sprint-store';

const clock = (): (() => Date) => {
  let n = 0;
  return () => new Date(`2026-06-${String(20 + n++).padStart(2, '0')}T09:00:00.000Z`);
};

describe('SprintStore', () => {
  it('creates SP-n sprints, persists JSON under .excalibur/sprints, reads them back', () => {
    const repo = makeTempDir();
    try {
      const store = new SprintStore(repo, { now: clock() });
      const a = store.createSprint({
        name: 'Sprint 1',
        startDate: '2026-07-01',
        endDate: '2026-07-14',
      });
      const b = store.createSprint({
        name: 'Sprint 2',
        goal: 'ship login',
        startDate: '2026-07-15',
        endDate: '2026-07-28',
        status: 'active',
      });
      expect(a.id).toBe('SP-1');
      expect(b.id).toBe('SP-2');
      expect(a.status).toBe('planned'); // default
      expect(b.goal).toBe('ship login');
      expect(existsSync(join(repo, '.excalibur', 'sprints', 'SP-2.json'))).toBe(true);

      // Newest first.
      expect(store.listSprints().map((s) => s.id)).toEqual(['SP-2', 'SP-1']);
      expect(store.getSprint('SP-1')?.name).toBe('Sprint 1');
      expect(store.activeSprint()?.id).toBe('SP-2');
    } finally {
      removeDir(repo);
    }
  });

  it('updates a sprint (status/dates) and deletes it', () => {
    const repo = makeTempDir();
    try {
      const store = new SprintStore(repo, { now: clock() });
      const s = store.createSprint({ name: 'S', startDate: '2026-07-01', endDate: '2026-07-14' });
      expect(store.updateSprint(s.id, { status: 'active', goal: 'go' })?.status).toBe('active');
      expect(store.getSprint(s.id)?.goal).toBe('go');
      expect(store.getSprint(s.id)?.startDate).toBe('2026-07-01'); // untouched

      expect(store.deleteSprint(s.id)).toBe(true);
      expect(store.getSprint(s.id)).toBeNull();
      expect(store.deleteSprint(s.id)).toBe(false); // already gone
    } finally {
      removeDir(repo);
    }
  });

  it('returns null/false for unknown and path-unsafe ids (never throws)', () => {
    const repo = makeTempDir();
    try {
      const store = new SprintStore(repo, { now: clock() });
      expect(store.listSprints()).toEqual([]);
      expect(store.getSprint('SP-9')).toBeNull();
      expect(store.getSprint('../../etc/passwd')).toBeNull();
      expect(store.updateSprint('SP-9', { name: 'x' })).toBeNull();
      expect(store.deleteSprint('a/b')).toBe(false);
      expect(store.activeSprint()).toBeNull();
    } finally {
      removeDir(repo);
    }
  });
});
