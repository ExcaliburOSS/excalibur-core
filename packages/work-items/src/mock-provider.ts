import { ProviderError } from '@excalibur/shared';
import type { NormalizedWorkItem, NormalizedWorkItemUser, WorkItemProviderType } from './types';
import type {
  AddWorkItemCommentInput,
  GetWorkItemInput,
  LinkPullRequestInput,
  ListWorkItemsInput,
  UpdateWorkItemStatusInput,
  WorkItemProvider,
} from './provider';

/** Fixed base timestamp keeps mock mutations deterministic across runs. */
const MOCK_CLOCK_BASE_MS = Date.UTC(2026, 5, 1, 9, 0, 0);

const DEMO_ASSIGNEE: NormalizedWorkItemUser = {
  externalId: 'user-demo-1',
  name: 'Ada Rivera',
  email: 'ada@example.com',
  username: 'ada',
};

const DEMO_REPORTER: NormalizedWorkItemUser = {
  externalId: 'user-demo-2',
  name: 'Rafael Casuso',
  email: 'rafael@example.com',
  username: 'rafael',
};

const EXCALIBUR_BOT: NormalizedWorkItemUser = {
  externalId: 'user-excalibur-bot',
  name: 'Excalibur',
  email: null,
  username: 'excalibur',
};

function createDefaultSeed(type: WorkItemProviderType): NormalizedWorkItem[] {
  const base = {
    provider: type,
    assignee: DEMO_ASSIGNEE,
    reporter: DEMO_REPORTER,
    project: 'QuickContract',
    team: 'Platform',
    cycleOrSprint: 'Sprint 12',
    parentExternalId: null,
    links: [] as NormalizedWorkItem['links'],
  };
  return [
    {
      ...base,
      externalId: 'demo-item-1',
      key: 'DEMO-1',
      url: `https://workitems.example.com/${type}/DEMO-1`,
      title: 'Fix duplicate escrow release when payout retries overlap',
      description:
        'Retrying a failed payout can release the same escrow twice because the release ' +
        'handler is not idempotent. Add a guard so a release id can only be processed once.',
      status: 'in_progress',
      priority: 'urgent',
      labels: ['bug', 'payments'],
      comments: [
        {
          externalId: 'demo-comment-1',
          body: 'Reproduced in staging: two ledger entries for the same release id.',
          author: DEMO_REPORTER,
          createdAt: '2026-05-28T10:15:00.000Z',
          updatedAt: null,
          raw: { source: 'mock' },
        },
      ],
      createdAt: '2026-05-27T09:00:00.000Z',
      updatedAt: '2026-05-28T10:15:00.000Z',
      raw: { source: 'mock', key: 'DEMO-1' },
    },
    {
      ...base,
      externalId: 'demo-item-2',
      key: 'DEMO-2',
      url: `https://workitems.example.com/${type}/DEMO-2`,
      title: 'Add idempotency keys to the contract signing API',
      description:
        'Clients occasionally submit the same signing request twice. Accept an ' +
        'Idempotency-Key header and return the original response on replays.',
      status: 'todo',
      priority: 'high',
      labels: ['feature', 'api'],
      comments: [],
      createdAt: '2026-05-29T11:30:00.000Z',
      updatedAt: '2026-05-29T11:30:00.000Z',
      raw: { source: 'mock', key: 'DEMO-2' },
    },
    {
      ...base,
      externalId: 'demo-item-3',
      key: 'DEMO-3',
      url: `https://workitems.example.com/${type}/DEMO-3`,
      title: 'Refactor notification service to queue-based delivery',
      description:
        'Notifications are sent inline in request handlers and slow down responses. ' +
        'Move delivery onto the existing job queue with retry and dead-letter handling.',
      status: 'backlog',
      priority: 'medium',
      labels: ['refactor', 'notifications'],
      comments: [],
      createdAt: '2026-05-30T14:45:00.000Z',
      updatedAt: '2026-05-30T14:45:00.000Z',
      raw: { source: 'mock', key: 'DEMO-3' },
    },
  ];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function equalsIgnoreCase(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

function matchesUser(user: NormalizedWorkItemUser | null, needle: string): boolean {
  if (user === null) {
    return false;
  }
  return (
    equalsIgnoreCase(user.username, needle) ||
    equalsIgnoreCase(user.email, needle) ||
    equalsIgnoreCase(user.name, needle) ||
    equalsIgnoreCase(user.externalId, needle)
  );
}

/**
 * Deterministic in-memory work item provider for demos and tests (M1).
 *
 * `type` is one of the real provider types passed at construction. The default
 * seed is three plausible items keyed `DEMO-1..3`. All write operations are
 * recorded in memory (`recordedComments`, `recordedStatusUpdates`,
 * `recordedLinks`) so tests can assert on them; seed items must be
 * structured-cloneable.
 */
export class MockWorkItemProvider implements WorkItemProvider {
  readonly type: WorkItemProviderType;

  private readonly items: NormalizedWorkItem[];
  private readonly commentLog: AddWorkItemCommentInput[] = [];
  private readonly statusLog: UpdateWorkItemStatusInput[] = [];
  private readonly linkLog: LinkPullRequestInput[] = [];
  private mutationCount = 0;

  constructor(type: WorkItemProviderType, seed?: NormalizedWorkItem[]) {
    this.type = type;
    this.items = (seed ?? createDefaultSeed(type)).map((item) => clone(item));
  }

  /** Comments added through `addComment`, in call order. */
  get recordedComments(): ReadonlyArray<AddWorkItemCommentInput> {
    return [...this.commentLog];
  }

  /** Status updates applied through `updateStatus`, in call order. */
  get recordedStatusUpdates(): ReadonlyArray<UpdateWorkItemStatusInput> {
    return [...this.statusLog];
  }

  /** Pull request links created through `linkPullRequest`, in call order. */
  get recordedLinks(): ReadonlyArray<LinkPullRequestInput> {
    return [...this.linkLog];
  }

  async getWorkItem(input: GetWorkItemInput): Promise<NormalizedWorkItem> {
    return clone(this.findItem(input.externalIdOrKey));
  }

  async listWorkItems(input: ListWorkItemsInput): Promise<NormalizedWorkItem[]> {
    let results = this.items.filter((item) => {
      if (input.query !== undefined) {
        const haystack = `${item.title}\n${item.description ?? ''}`.toLowerCase();
        if (!haystack.includes(input.query.toLowerCase())) {
          return false;
        }
      }
      if (input.status !== undefined && !equalsIgnoreCase(item.status, input.status)) {
        return false;
      }
      if (input.assignee !== undefined && !matchesUser(item.assignee, input.assignee)) {
        return false;
      }
      if (input.project !== undefined && !equalsIgnoreCase(item.project, input.project)) {
        return false;
      }
      if (input.team !== undefined && !equalsIgnoreCase(item.team, input.team)) {
        return false;
      }
      if (input.labels !== undefined && input.labels.length > 0) {
        const itemLabels = item.labels.map((label) => label.toLowerCase());
        const hasAll = input.labels.every((label) => itemLabels.includes(label.toLowerCase()));
        if (!hasAll) {
          return false;
        }
      }
      return true;
    });
    if (input.limit !== undefined) {
      results = results.slice(0, input.limit);
    }
    return results.map((item) => clone(item));
  }

  async addComment(input: AddWorkItemCommentInput): Promise<void> {
    const item = this.findItem(input.externalIdOrKey);
    const timestamp = this.nextTimestamp();
    item.comments.push({
      externalId: `mock-comment-${item.key}-${item.comments.length + 1}`,
      body: input.body,
      author: clone(EXCALIBUR_BOT),
      createdAt: timestamp,
      updatedAt: null,
      raw: { source: 'mock', integrationId: input.integrationId },
    });
    item.updatedAt = timestamp;
    this.commentLog.push(clone(input));
  }

  async updateStatus(input: UpdateWorkItemStatusInput): Promise<void> {
    const item = this.findItem(input.externalIdOrKey);
    item.status = input.status;
    item.updatedAt = this.nextTimestamp();
    this.statusLog.push(clone(input));
  }

  async linkPullRequest(input: LinkPullRequestInput): Promise<void> {
    const item = this.findItem(input.externalIdOrKey);
    item.links.push({
      type: 'pull_request',
      url: input.pullRequest.url,
      title: input.pullRequest.title,
      raw: { source: 'mock', pullRequest: clone(input.pullRequest) },
    });
    item.updatedAt = this.nextTimestamp();
    this.linkLog.push(clone(input));
  }

  async validateCredentials(): Promise<boolean> {
    return true;
  }

  private findItem(externalIdOrKey: string): NormalizedWorkItem {
    const item = this.items.find(
      (candidate) =>
        candidate.externalId === externalIdOrKey ||
        candidate.key.toLowerCase() === externalIdOrKey.toLowerCase(),
    );
    if (item === undefined) {
      throw new ProviderError(`Work item not found: "${externalIdOrKey}".`, {
        code: 'work_item_not_found',
        details: { provider: this.type, externalIdOrKey },
      });
    }
    return item;
  }

  private nextTimestamp(): string {
    this.mutationCount += 1;
    return new Date(MOCK_CLOCK_BASE_MS + this.mutationCount * 1000).toISOString();
  }
}
