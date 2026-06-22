import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalWorkItemProvider } from './local-provider';

function freshRepo(): string {
  return mkdtempSync(join(tmpdir(), 'excalibur-wi-'));
}
const clock = (): (() => Date) => {
  let t = Date.parse('2026-06-20T10:00:00.000Z');
  return () => new Date((t += 1000));
};
const ID = { integrationId: 'local' };

describe('LocalWorkItemProvider', () => {
  it('creates sequential WI-n keys, persists JSON, and reads them back', async () => {
    const root = freshRepo();
    const p = new LocalWorkItemProvider(root, { now: clock() });
    const a = p.createWorkItem({ title: 'First task' });
    const b = p.createWorkItem({ title: 'Second task', labels: ['bug'], description: 'details' });
    expect(a.key).toBe('WI-1');
    expect(b.key).toBe('WI-2');
    expect(a.provider).toBe('local');
    // persisted on disk
    const onDisk = JSON.parse(
      readFileSync(join(root, '.excalibur', 'work-items', 'WI-2.json'), 'utf8'),
    );
    expect(onDisk.title).toBe('Second task');
    expect(onDisk.labels).toEqual(['bug']);
    // read back through the interface
    const got = await p.getWorkItem({ ...ID, externalIdOrKey: 'WI-1' });
    expect(got.title).toBe('First task');
    expect(got.status).toBe('open');
  });

  it('lists newest-first and filters by status, query and labels', async () => {
    const root = freshRepo();
    const p = new LocalWorkItemProvider(root, { now: clock() });
    p.createWorkItem({ title: 'alpha', labels: ['ui'] });
    const second = p.createWorkItem({ title: 'beta webhook', labels: ['api'] });
    p.createWorkItem({ title: 'gamma' });
    await p.updateStatus({ ...ID, externalIdOrKey: second.key, status: 'closed' });

    const all = await p.listWorkItems(ID);
    expect(all.map((i) => i.key)).toEqual(['WI-3', 'WI-2', 'WI-1']); // newest first
    expect((await p.listWorkItems({ ...ID, status: 'open' })).map((i) => i.key)).toEqual([
      'WI-3',
      'WI-1',
    ]);
    expect((await p.listWorkItems({ ...ID, query: 'webhook' })).map((i) => i.key)).toEqual([
      'WI-2',
    ]);
    expect((await p.listWorkItems({ ...ID, labels: ['api'] })).map((i) => i.key)).toEqual(['WI-2']);
    expect((await p.listWorkItems({ ...ID, limit: 1 })).map((i) => i.key)).toEqual(['WI-3']);
  });

  it('appends comments, updates status, and links a PR (persisted)', async () => {
    const root = freshRepo();
    const p = new LocalWorkItemProvider(root, { now: clock() });
    const wi = p.createWorkItem({ title: 'task' });
    await p.addComment({ ...ID, externalIdOrKey: wi.key, body: 'first note' });
    await p.addComment({ ...ID, externalIdOrKey: wi.key, body: 'second note' });
    await p.updateStatus({ ...ID, externalIdOrKey: wi.key, status: 'in_progress' });
    await p.linkPullRequest({
      ...ID,
      externalIdOrKey: wi.key,
      pullRequest: { provider: 'github', url: 'https://x/pr/1', title: 'PR 1', number: 1 },
    });
    const got = await p.getWorkItem({ ...ID, externalIdOrKey: wi.key });
    expect(got.comments.map((c) => c.body)).toEqual(['first note', 'second note']);
    expect(got.status).toBe('in_progress');
    expect(got.links).toHaveLength(1);
    expect(got.links[0]?.type).toBe('pull_request');
  });

  it('rejects a missing item and validates without credentials', async () => {
    const p = new LocalWorkItemProvider(freshRepo(), { now: clock() });
    await expect(p.getWorkItem({ ...ID, externalIdOrKey: 'WI-99' })).rejects.toThrow(/not found/);
    await expect(p.validateCredentials()).resolves.toBe(true);
    await expect(p.listWorkItems(ID)).resolves.toEqual([]); // empty backlog → no dir, no error
  });

  it('refuses a path-traversal / malformed key (confined to WI-<n>)', async () => {
    const p = new LocalWorkItemProvider(freshRepo(), { now: clock() });
    for (const bad of ['../../etc/passwd', 'WI-1/../../x', 'nope', 'WI-', '']) {
      // The key guard rejects before any disk access (normalize the sync throw
      // and the promise rejection into one assertion).
      await expect(
        Promise.resolve().then(() => p.getWorkItem({ ...ID, externalIdOrKey: bad })),
      ).rejects.toThrow(/invalid work item key/);
    }
  });
});
