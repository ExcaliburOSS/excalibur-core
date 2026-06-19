import { describe, expect, it } from 'vitest';
import {
  normalizedWorkItemCommentSchema,
  normalizedWorkItemLinkSchema,
  normalizedWorkItemSchema,
  normalizedWorkItemUserSchema,
  workItemProviderTypeSchema,
  type NormalizedWorkItem,
} from './types';
import {
  addWorkItemCommentInputSchema,
  getWorkItemInputSchema,
  linkPullRequestInputSchema,
  listWorkItemsInputSchema,
  updateWorkItemStatusInputSchema,
} from './provider';

const VALID_ITEM: NormalizedWorkItem = {
  provider: 'linear',
  externalId: 'item-1',
  key: 'ENG-123',
  url: 'https://linear.app/acme/issue/ENG-123',
  title: 'Fix duplicate escrow release',
  description: 'The release handler is not idempotent.',
  status: 'in_progress',
  priority: 'urgent',
  labels: ['bug', 'payments'],
  assignee: { externalId: 'u1', name: 'Ada', email: 'ada@example.com', username: 'ada' },
  reporter: null,
  project: 'QuickContract',
  team: 'Platform',
  cycleOrSprint: 'Sprint 12',
  parentExternalId: null,
  comments: [
    {
      externalId: 'c1',
      body: 'Reproduced in staging.',
      author: null,
      createdAt: '2026-05-28T10:15:00.000Z',
      updatedAt: null,
      raw: { id: 'c1' },
    },
  ],
  links: [
    {
      type: 'pull_request',
      url: 'https://github.com/acme/api/pull/42',
      title: 'Fix release',
      raw: {},
    },
  ],
  createdAt: '2026-05-27T09:00:00.000Z',
  updatedAt: '2026-05-28T10:15:00.000Z',
  raw: { source: 'linear' },
};

describe('workItemProviderTypeSchema', () => {
  it('accepts exactly the seven provider types', () => {
    expect(workItemProviderTypeSchema.options).toEqual([
      'linear',
      'jira',
      'github_issues',
      'gitlab_issues',
      'shortcut',
      'azure_devops',
      'youtrack',
    ]);
    for (const value of workItemProviderTypeSchema.options) {
      expect(workItemProviderTypeSchema.safeParse(value).success).toBe(true);
    }
    expect(workItemProviderTypeSchema.safeParse('github').success).toBe(false);
    expect(workItemProviderTypeSchema.safeParse('mock').success).toBe(false);
  });
});

describe('normalized model schemas', () => {
  it('parses a fully populated normalized work item', () => {
    const result = normalizedWorkItemSchema.safeParse(VALID_ITEM);
    expect(result.success).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(normalizedWorkItemSchema.safeParse({ ...VALID_ITEM, provider: 'trello' }).success).toBe(
      false,
    );
  });

  it('rejects missing required fields', () => {
    const { key: _key, ...withoutKey } = VALID_ITEM;
    expect(normalizedWorkItemSchema.safeParse(withoutKey).success).toBe(false);
    expect(normalizedWorkItemSchema.safeParse({ ...VALID_ITEM, labels: 'bug' }).success).toBe(
      false,
    );
    expect(normalizedWorkItemSchema.safeParse({ ...VALID_ITEM, title: null }).success).toBe(false);
  });

  it('requires nullable fields to be present (null, not absent)', () => {
    const { description: _description, ...withoutDescription } = VALID_ITEM;
    expect(normalizedWorkItemSchema.safeParse(withoutDescription).success).toBe(false);
  });

  it('validates users with all-nullable fields', () => {
    expect(
      normalizedWorkItemUserSchema.safeParse({
        externalId: null,
        name: null,
        email: null,
        username: null,
      }).success,
    ).toBe(true);
    expect(normalizedWorkItemUserSchema.safeParse({ externalId: null }).success).toBe(false);
  });

  it('validates comments and rejects malformed ones', () => {
    expect(normalizedWorkItemCommentSchema.safeParse(VALID_ITEM.comments[0]).success).toBe(true);
    expect(normalizedWorkItemCommentSchema.safeParse({ externalId: 'c1', body: 42 }).success).toBe(
      false,
    );
  });

  it('validates link types against the closed enum', () => {
    for (const type of ['pull_request', 'commit', 'document', 'url', 'issue', 'other']) {
      expect(
        normalizedWorkItemLinkSchema.safeParse({ type, url: 'https://x', title: null, raw: null })
          .success,
      ).toBe(true);
    }
    expect(
      normalizedWorkItemLinkSchema.safeParse({
        type: 'branch',
        url: 'https://x',
        title: null,
        raw: null,
      }).success,
    ).toBe(false);
  });
});

describe('provider input schemas', () => {
  it('validates GetWorkItemInput', () => {
    expect(
      getWorkItemInputSchema.safeParse({ integrationId: 'i1', externalIdOrKey: 'ENG-1' }).success,
    ).toBe(true);
    expect(getWorkItemInputSchema.safeParse({ externalIdOrKey: 'ENG-1' }).success).toBe(false);
  });

  it('validates ListWorkItemsInput with optional filters', () => {
    expect(listWorkItemsInputSchema.safeParse({ integrationId: 'i1' }).success).toBe(true);
    expect(
      listWorkItemsInputSchema.safeParse({
        integrationId: 'i1',
        query: 'escrow',
        status: 'todo',
        assignee: 'ada',
        project: 'QuickContract',
        team: 'Platform',
        labels: ['bug'],
        limit: 10,
      }).success,
    ).toBe(true);
    expect(listWorkItemsInputSchema.safeParse({ integrationId: 'i1', limit: 0 }).success).toBe(
      false,
    );
    expect(listWorkItemsInputSchema.safeParse({ integrationId: 'i1', limit: 1.5 }).success).toBe(
      false,
    );
  });

  it('validates AddWorkItemCommentInput and UpdateWorkItemStatusInput', () => {
    expect(
      addWorkItemCommentInputSchema.safeParse({
        integrationId: 'i1',
        externalIdOrKey: 'ENG-1',
        body: 'hi',
      }).success,
    ).toBe(true);
    expect(
      addWorkItemCommentInputSchema.safeParse({ integrationId: 'i1', externalIdOrKey: 'ENG-1' })
        .success,
    ).toBe(false);
    expect(
      updateWorkItemStatusInputSchema.safeParse({
        integrationId: 'i1',
        externalIdOrKey: 'ENG-1',
        status: 'done',
      }).success,
    ).toBe(true);
  });

  it('validates LinkPullRequestInput including the VCS provider enum', () => {
    const valid = {
      integrationId: 'i1',
      externalIdOrKey: 'ENG-1',
      pullRequest: {
        provider: 'github',
        url: 'https://github.com/acme/api/pull/42',
        title: 'Fix release',
        number: 42,
        repositoryFullName: 'acme/api',
      },
    };
    expect(linkPullRequestInputSchema.safeParse(valid).success).toBe(true);
    expect(
      linkPullRequestInputSchema.safeParse({
        ...valid,
        pullRequest: { ...valid.pullRequest, provider: 'gitea' },
      }).success,
    ).toBe(false);
    expect(
      linkPullRequestInputSchema.safeParse({
        ...valid,
        pullRequest: { provider: 'gitlab', url: 'https://gitlab.com/x/1', title: 'T' },
      }).success,
    ).toBe(true);
  });
});
