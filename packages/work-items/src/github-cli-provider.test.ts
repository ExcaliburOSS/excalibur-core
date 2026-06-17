import { describe, expect, it, vi } from 'vitest';
import { GitHubCliProvider, mapGhIssue, type GhRunner } from './github-cli-provider';

const ISSUE = {
  number: 42,
  title: 'Add contract renewal reminders',
  state: 'OPEN',
  body: 'We need reminders before renewal.',
  url: 'https://github.com/acme/app/issues/42',
  labels: [{ name: 'feature' }, { name: 'billing' }],
  author: { login: 'alice' },
  assignees: [{ login: 'bob' }],
  createdAt: '2026-06-10T10:00:00Z',
  updatedAt: '2026-06-12T12:00:00Z',
  comments: [{ author: { login: 'carol' }, body: 'Scope it first?', createdAt: '2026-06-11T09:00:00Z' }],
};

describe('mapGhIssue', () => {
  it('maps a gh issue JSON object to a NormalizedWorkItem', () => {
    const wi = mapGhIssue(ISSUE, 'acme/app');
    expect(wi.provider).toBe('github_issues');
    expect(wi.externalId).toBe('42');
    expect(wi.key).toBe('acme/app#42');
    expect(wi.status).toBe('open'); // OPEN → normalized lowercase
    expect(wi.labels).toEqual(['feature', 'billing']);
    expect(wi.reporter?.name).toBe('alice');
    expect(wi.assignee?.name).toBe('bob');
    expect(wi.comments).toHaveLength(1);
    expect(wi.comments[0]?.body).toBe('Scope it first?');
  });
});

describe('GitHubCliProvider', () => {
  it('lists issues via `gh issue list --json` and maps them', async () => {
    const run: GhRunner = vi.fn(async (args) => {
      expect(args.slice(0, 3)).toEqual(['issue', 'list', '--json']);
      expect(args).toContain('--repo');
      expect(args).toContain('acme/app');
      return JSON.stringify([ISSUE]);
    });
    const items = await new GitHubCliProvider(run, 'acme/app').listWorkItems({
      integrationId: 'local',
      limit: 10,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Add contract renewal reminders');
  });

  it('fetches a single issue via `gh issue view`', async () => {
    const run: GhRunner = vi.fn(async (args) => {
      expect(args[0]).toBe('issue');
      expect(args[1]).toBe('view');
      expect(args[2]).toBe('42');
      return JSON.stringify(ISSUE);
    });
    const wi = await new GitHubCliProvider(run).getWorkItem({
      integrationId: 'local',
      externalIdOrKey: '42',
    });
    expect(wi.key).toBe('.#42');
  });

  it('comments via `gh issue comment`', async () => {
    const calls: string[][] = [];
    const run: GhRunner = vi.fn(async (args) => {
      calls.push(args);
      return '';
    });
    await new GitHubCliProvider(run, 'acme/app').addComment({
      integrationId: 'local',
      externalIdOrKey: '42',
      body: 'On it.',
    });
    expect(calls[0]).toEqual(['issue', 'comment', '42', '--body', 'On it.', '--repo', 'acme/app']);
  });

  it('closes the issue on a done-like status, reopens otherwise', async () => {
    const verbs: string[] = [];
    const run: GhRunner = vi.fn(async (args) => {
      verbs.push(args[1] as string);
      return '';
    });
    const p = new GitHubCliProvider(run);
    await p.updateStatus({ integrationId: 'l', externalIdOrKey: '42', status: 'done' });
    await p.updateStatus({ integrationId: 'l', externalIdOrKey: '42', status: 'in_progress' });
    expect(verbs).toEqual(['close', 'reopen']);
  });

  it('validateCredentials reflects `gh auth status` success/failure', async () => {
    const ok = await new GitHubCliProvider(async () => 'logged in').validateCredentials();
    expect(ok).toBe(true);
    const bad = await new GitHubCliProvider(async () => {
      throw new Error('not logged in');
    }).validateCredentials();
    expect(bad).toBe(false);
  });
});
