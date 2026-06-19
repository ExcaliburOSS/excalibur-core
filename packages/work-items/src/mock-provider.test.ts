import { describe, expect, it } from 'vitest';
import { ExcaliburError, ProviderError } from '@excalibur/shared';
import { MockWorkItemProvider } from './mock-provider';
import { normalizedWorkItemSchema, type NormalizedWorkItem } from './types';

const INTEGRATION = { integrationId: 'int-1' };

function customItem(overrides: Partial<NormalizedWorkItem>): NormalizedWorkItem {
  return {
    provider: 'jira',
    externalId: 'custom-1',
    key: 'CUST-1',
    url: 'https://example.com/CUST-1',
    title: 'Custom item',
    description: null,
    status: 'todo',
    priority: null,
    labels: [],
    assignee: null,
    reporter: null,
    project: null,
    team: null,
    cycleOrSprint: null,
    parentExternalId: null,
    comments: [],
    links: [],
    createdAt: null,
    updatedAt: null,
    raw: null,
    ...overrides,
  };
}

describe('MockWorkItemProvider — seed', () => {
  it('exposes the constructor provider type', () => {
    expect(new MockWorkItemProvider('linear').type).toBe('linear');
    expect(new MockWorkItemProvider('github_issues').type).toBe('github_issues');
  });

  it('seeds three deterministic items keyed DEMO-1..3', async () => {
    const provider = new MockWorkItemProvider('linear');
    const items = await provider.listWorkItems(INTEGRATION);
    expect(items.map((item) => item.key)).toEqual(['DEMO-1', 'DEMO-2', 'DEMO-3']);
    expect(items.every((item) => item.provider === 'linear')).toBe(true);
  });

  it('produces identical seed data across instances (deterministic)', async () => {
    const a = await new MockWorkItemProvider('jira').listWorkItems(INTEGRATION);
    const b = await new MockWorkItemProvider('jira').listWorkItems(INTEGRATION);
    expect(a).toEqual(b);
  });

  it('seed items validate against normalizedWorkItemSchema', async () => {
    const items = await new MockWorkItemProvider('azure_devops').listWorkItems(INTEGRATION);
    for (const item of items) {
      expect(normalizedWorkItemSchema.safeParse(item).success).toBe(true);
    }
  });

  it('accepts a custom seed instead of the default items', async () => {
    const provider = new MockWorkItemProvider('jira', [customItem({})]);
    const items = await provider.listWorkItems(INTEGRATION);
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe('CUST-1');
  });

  it('clones the seed so external mutation does not leak in', async () => {
    const seed = [customItem({})];
    const provider = new MockWorkItemProvider('jira', seed);
    seed[0]!.title = 'mutated';
    const item = await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'CUST-1' });
    expect(item.title).toBe('Custom item');
  });
});

describe('MockWorkItemProvider — getWorkItem', () => {
  it('finds items by key (case-insensitive) and by externalId', async () => {
    const provider = new MockWorkItemProvider('linear');
    expect((await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'DEMO-1' })).key).toBe(
      'DEMO-1',
    );
    expect((await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'demo-2' })).key).toBe(
      'DEMO-2',
    );
    expect(
      (await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'demo-item-3' })).key,
    ).toBe('DEMO-3');
  });

  it('throws ProviderError with code work_item_not_found for unknown ids', async () => {
    const provider = new MockWorkItemProvider('linear');
    const promise = provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'NOPE-1' });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await expect(promise).rejects.toBeInstanceOf(ExcaliburError);
    await expect(promise).rejects.toMatchObject({ code: 'work_item_not_found' });
  });

  it('returns copies so callers cannot mutate stored items', async () => {
    const provider = new MockWorkItemProvider('linear');
    const first = await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'DEMO-1' });
    first.title = 'mutated';
    first.labels.push('mutated');
    const second = await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'DEMO-1' });
    expect(second.title).not.toBe('mutated');
    expect(second.labels).not.toContain('mutated');
  });
});

describe('MockWorkItemProvider — listWorkItems filters', () => {
  const provider = new MockWorkItemProvider('linear');

  it('filters by query over title and description (case-insensitive)', async () => {
    const byTitle = await provider.listWorkItems({ ...INTEGRATION, query: 'ESCROW' });
    expect(byTitle.map((item) => item.key)).toEqual(['DEMO-1']);
    const byDescription = await provider.listWorkItems({
      ...INTEGRATION,
      query: 'idempotency-key',
    });
    expect(byDescription.map((item) => item.key)).toEqual(['DEMO-2']);
  });

  it('filters by status', async () => {
    const items = await provider.listWorkItems({ ...INTEGRATION, status: 'TODO' });
    expect(items.map((item) => item.key)).toEqual(['DEMO-2']);
  });

  it('filters by assignee username/email/name', async () => {
    expect(await provider.listWorkItems({ ...INTEGRATION, assignee: 'ada' })).toHaveLength(3);
    expect(
      await provider.listWorkItems({ ...INTEGRATION, assignee: 'ada@example.com' }),
    ).toHaveLength(3);
    expect(await provider.listWorkItems({ ...INTEGRATION, assignee: 'nobody' })).toHaveLength(0);
  });

  it('filters by project and team', async () => {
    expect(await provider.listWorkItems({ ...INTEGRATION, project: 'quickcontract' })).toHaveLength(
      3,
    );
    expect(await provider.listWorkItems({ ...INTEGRATION, team: 'Platform' })).toHaveLength(3);
    expect(await provider.listWorkItems({ ...INTEGRATION, team: 'Design' })).toHaveLength(0);
  });

  it('requires every requested label', async () => {
    const both = await provider.listWorkItems({ ...INTEGRATION, labels: ['bug', 'payments'] });
    expect(both.map((item) => item.key)).toEqual(['DEMO-1']);
    const none = await provider.listWorkItems({ ...INTEGRATION, labels: ['bug', 'api'] });
    expect(none).toHaveLength(0);
  });

  it('applies limit after filtering', async () => {
    const items = await provider.listWorkItems({ ...INTEGRATION, limit: 2 });
    expect(items.map((item) => item.key)).toEqual(['DEMO-1', 'DEMO-2']);
  });

  it('combines filters', async () => {
    const items = await provider.listWorkItems({
      ...INTEGRATION,
      query: 'idempotency',
      status: 'todo',
      labels: ['api'],
    });
    expect(items.map((item) => item.key)).toEqual(['DEMO-2']);
  });
});

describe('MockWorkItemProvider — writes are recorded in memory', () => {
  it('records comments and appends them to the item', async () => {
    const provider = new MockWorkItemProvider('linear');
    await provider.addComment({
      ...INTEGRATION,
      externalIdOrKey: 'DEMO-1',
      body: 'Excalibur started an agentic run.',
    });
    await provider.addComment({ ...INTEGRATION, externalIdOrKey: 'DEMO-2', body: 'Plan ready.' });

    expect(provider.recordedComments).toEqual([
      {
        integrationId: 'int-1',
        externalIdOrKey: 'DEMO-1',
        body: 'Excalibur started an agentic run.',
      },
      { integrationId: 'int-1', externalIdOrKey: 'DEMO-2', body: 'Plan ready.' },
    ]);

    const demo1 = await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'DEMO-1' });
    expect(demo1.comments).toHaveLength(2);
    expect(demo1.comments[1]).toMatchObject({
      externalId: 'mock-comment-DEMO-1-2',
      body: 'Excalibur started an agentic run.',
      author: { username: 'excalibur' },
    });
  });

  it('records status updates and applies them to the item', async () => {
    const provider = new MockWorkItemProvider('jira');
    await provider.updateStatus({ ...INTEGRATION, externalIdOrKey: 'DEMO-2', status: 'in_review' });
    expect(provider.recordedStatusUpdates).toEqual([
      { integrationId: 'int-1', externalIdOrKey: 'DEMO-2', status: 'in_review' },
    ]);
    const item = await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'DEMO-2' });
    expect(item.status).toBe('in_review');
  });

  it('records pull request links and appends a pull_request link to the item', async () => {
    const provider = new MockWorkItemProvider('github_issues');
    const pullRequest = {
      provider: 'github' as const,
      url: 'https://github.com/acme/quickcontract-api/pull/42',
      title: 'Fix duplicate escrow release',
      number: 42,
      repositoryFullName: 'acme/quickcontract-api',
    };
    await provider.linkPullRequest({ ...INTEGRATION, externalIdOrKey: 'DEMO-1', pullRequest });

    expect(provider.recordedLinks).toEqual([
      { integrationId: 'int-1', externalIdOrKey: 'DEMO-1', pullRequest },
    ]);
    const item = await provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'DEMO-1' });
    expect(item.links).toHaveLength(1);
    expect(item.links[0]).toMatchObject({
      type: 'pull_request',
      url: pullRequest.url,
      title: pullRequest.title,
    });
  });

  it('rejects writes against unknown items without recording them', async () => {
    const provider = new MockWorkItemProvider('linear');
    await expect(
      provider.addComment({ ...INTEGRATION, externalIdOrKey: 'NOPE-1', body: 'x' }),
    ).rejects.toMatchObject({ code: 'work_item_not_found' });
    expect(provider.recordedComments).toHaveLength(0);
  });

  it('mutated items still validate against the schema and stay deterministic', async () => {
    const run = async (): Promise<NormalizedWorkItem> => {
      const provider = new MockWorkItemProvider('linear');
      await provider.addComment({ ...INTEGRATION, externalIdOrKey: 'DEMO-1', body: 'hello' });
      await provider.updateStatus({ ...INTEGRATION, externalIdOrKey: 'DEMO-1', status: 'done' });
      return provider.getWorkItem({ ...INTEGRATION, externalIdOrKey: 'DEMO-1' });
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toEqual(b);
    expect(normalizedWorkItemSchema.safeParse(a).success).toBe(true);
  });

  it('validateCredentials always resolves true', async () => {
    await expect(new MockWorkItemProvider('youtrack').validateCredentials()).resolves.toBe(true);
  });
});
