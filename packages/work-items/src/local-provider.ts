import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizedWorkItemSchema,
  type NormalizedWorkItem,
  type NormalizedWorkItemComment,
} from './types';
import type {
  AddWorkItemCommentInput,
  GetWorkItemInput,
  LinkPullRequestInput,
  ListWorkItemsInput,
  UpdateWorkItemStatusInput,
  WorkItemProvider,
} from './provider';

/**
 * The OSS **local, file-based** work-item provider — the one piece that makes the
 * work item the base unit in Core too (canonical domain model): a local backlog
 * with no Linear/Jira/GitHub and no cloud. Items live as JSON under
 * `.excalibur/work-items/<KEY>.json` (KEY = `WI-<n>`), portable + git-able, and
 * fold through the SAME {@link WorkItemProvider} interface every other provider
 * uses, so a run can attach to a local work item exactly like a remote one.
 *
 * It additionally exposes {@link createWorkItem} (creation is local-only — remote
 * providers create via their own tools), keeping the shared read/comment/status
 * interface intact.
 */
export interface CreateWorkItemInput {
  title: string;
  description?: string;
  labels?: string[];
  status?: string;
  priority?: string;
}

const KEY_RE = /^WI-(\d+)$/;

export class LocalWorkItemProvider implements WorkItemProvider {
  readonly type = 'local' as const;
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(repoRoot: string, options: { now?: () => Date } = {}) {
    this.dir = join(repoRoot, '.excalibur', 'work-items');
    this.now = options.now ?? ((): Date => new Date());
  }

  private fileFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  private readAll(): NormalizedWorkItem[] {
    if (!existsSync(this.dir)) {
      return [];
    }
    const items: NormalizedWorkItem[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      try {
        const parsed = normalizedWorkItemSchema.parse(
          JSON.parse(readFileSync(join(this.dir, name), 'utf8')),
        );
        items.push(parsed as NormalizedWorkItem);
      } catch {
        // Skip an unreadable/corrupt entry rather than failing the whole list.
      }
    }
    // Newest first by numeric key (WI-2 before WI-1), stable for equal/unknown.
    return items.sort((a, b) => keyNum(b.key) - keyNum(a.key));
  }

  private write(item: NormalizedWorkItem): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileFor(item.key), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
  }

  private nextKey(): string {
    let max = 0;
    if (existsSync(this.dir)) {
      for (const name of readdirSync(this.dir)) {
        const m = KEY_RE.exec(name.replace(/\.json$/, ''));
        if (m) {
          max = Math.max(max, Number.parseInt(m[1] as string, 10));
        }
      }
    }
    return `WI-${max + 1}`;
  }

  /** Creates a new local work item, persists it, and returns it. */
  createWorkItem(input: CreateWorkItemInput): NormalizedWorkItem {
    const key = this.nextKey();
    const ts = this.now().toISOString();
    const item: NormalizedWorkItem = {
      provider: 'local',
      externalId: key,
      key,
      url: `file://${this.fileFor(key)}`,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'open',
      priority: input.priority ?? null,
      labels: input.labels ?? [],
      assignee: null,
      reporter: null,
      project: null,
      team: null,
      cycleOrSprint: null,
      parentExternalId: null,
      comments: [],
      links: [],
      createdAt: ts,
      updatedAt: ts,
      raw: { local: true },
    };
    this.write(item);
    return item;
  }

  getWorkItem(input: GetWorkItemInput): Promise<NormalizedWorkItem> {
    const file = this.fileFor(input.externalIdOrKey);
    if (!existsSync(file)) {
      return Promise.reject(new Error(`local work item "${input.externalIdOrKey}" not found`));
    }
    return Promise.resolve(
      normalizedWorkItemSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) as NormalizedWorkItem,
    );
  }

  listWorkItems(input: ListWorkItemsInput): Promise<NormalizedWorkItem[]> {
    let items = this.readAll();
    if (input.status !== undefined && input.status !== 'all') {
      items = items.filter((i) => i.status === input.status);
    }
    if (input.query !== undefined && input.query.length > 0) {
      const q = input.query.toLowerCase();
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          (i.description ?? '').toLowerCase().includes(q) ||
          i.key.toLowerCase().includes(q),
      );
    }
    if (input.labels !== undefined && input.labels.length > 0) {
      items = items.filter((i) => input.labels!.every((l) => i.labels.includes(l)));
    }
    if (input.limit !== undefined) {
      items = items.slice(0, input.limit);
    }
    return Promise.resolve(items);
  }

  async addComment(input: AddWorkItemCommentInput): Promise<void> {
    const item = await this.getWorkItem({
      integrationId: input.integrationId,
      externalIdOrKey: input.externalIdOrKey,
    });
    const ts = this.now().toISOString();
    const comment: NormalizedWorkItemComment = {
      externalId: `c${item.comments.length + 1}`,
      body: input.body,
      author: null,
      createdAt: ts,
      updatedAt: ts,
      raw: { local: true },
    };
    item.comments.push(comment);
    item.updatedAt = ts;
    this.write(item);
  }

  async updateStatus(input: UpdateWorkItemStatusInput): Promise<void> {
    const item = await this.getWorkItem({
      integrationId: input.integrationId,
      externalIdOrKey: input.externalIdOrKey,
    });
    item.status = input.status;
    item.updatedAt = this.now().toISOString();
    this.write(item);
  }

  async linkPullRequest(input: LinkPullRequestInput): Promise<void> {
    const item = await this.getWorkItem({
      integrationId: input.integrationId,
      externalIdOrKey: input.externalIdOrKey,
    });
    item.links.push({
      type: 'pull_request',
      url: input.pullRequest.url,
      title: input.pullRequest.title,
      raw: input.pullRequest,
    });
    item.updatedAt = this.now().toISOString();
    this.write(item);
  }

  validateCredentials(): Promise<boolean> {
    return Promise.resolve(true); // local files — no credentials
  }
}

function keyNum(key: string): number {
  const m = KEY_RE.exec(key);
  return m ? Number.parseInt(m[1] as string, 10) : 0;
}
