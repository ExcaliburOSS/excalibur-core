import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { laneOf, WORK_ITEM_LANES, type WorkItemLane } from './lanes';
import {
  normalizedWorkItemSchema,
  type NormalizedWorkItem,
  type NormalizedWorkItemChecklistItem,
  type NormalizedWorkItemComment,
  type NormalizedWorkItemUser,
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
  /** Assignee display name (local items have no user directory). */
  assignee?: string | null;
  /** Parent work-item key, for sub-tasks. */
  parentExternalId?: string | null;
  /** Work-item keys this item is blocked by (dependency edges — PLAN2). */
  blockedBy?: string[];
  /** Effort estimate in story points (PLAN5). */
  estimate?: number;
  /** The sprint/cycle id this item belongs to (PLAN5). */
  cycleOrSprint?: string | null;
}

/** Fields a {@link LocalWorkItemProvider.updateWorkItem} may patch (all optional). */
export interface UpdateWorkItemInput {
  title?: string;
  description?: string | null;
  labels?: string[];
  status?: string;
  priority?: string | null;
  assignee?: string | null;
  parentExternalId?: string | null;
  order?: number;
  /** Work-item keys this item is blocked by (dependency edges — PLAN2). */
  blockedBy?: string[];
  /** Effort estimate in story points (PLAN5). */
  estimate?: number;
  /** The sprint/cycle id this item belongs to (PLAN5). */
  cycleOrSprint?: string | null;
}

/** A kanban lane plus its items, in board order. */
export interface WorkItemBoardLane {
  lane: WorkItemLane;
  items: NormalizedWorkItem[];
}

const KEY_RE = /^WI-(\d+)$/;

/** Builds a minimal user record from a display name (local items have no directory). */
function userFromName(name: string | null | undefined): NormalizedWorkItemUser | null {
  if (name === null || name === undefined || name.trim().length === 0) {
    return null;
  }
  return { externalId: null, name, email: null, username: null };
}

export class LocalWorkItemProvider implements WorkItemProvider {
  readonly type = 'local' as const;
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(repoRoot: string, options: { now?: () => Date } = {}) {
    this.dir = join(repoRoot, '.excalibur', 'work-items');
    this.now = options.now ?? ((): Date => new Date());
  }

  private fileFor(key: string): string {
    // Confine the key to the `WI-<n>` shape so a crafted externalIdOrKey (e.g.
    // `../../etc/passwd`) can never escape the work-items folder — defense in
    // depth even though callers/serve already validate the shape.
    if (!KEY_RE.test(key)) {
      throw new Error(`invalid work item key "${key}"`);
    }
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
    // Default stays `open` (laneOf maps it to the To-do lane) so existing
    // open/closed flows are unchanged; explicit moves use canonical lane ids.
    const status = input.status ?? 'open';
    const item: NormalizedWorkItem = {
      provider: 'local',
      externalId: key,
      key,
      url: `file://${this.fileFor(key)}`,
      title: input.title,
      description: input.description ?? null,
      status,
      priority: input.priority ?? null,
      labels: input.labels ?? [],
      assignee: userFromName(input.assignee),
      reporter: null,
      project: null,
      team: null,
      cycleOrSprint: input.cycleOrSprint ?? null,
      parentExternalId: input.parentExternalId ?? null,
      comments: [],
      links: [],
      createdAt: ts,
      updatedAt: ts,
      // Append to the end of its lane so the board has a stable rank.
      order: this.nextOrder(laneOf(status)),
      ...(input.blockedBy !== undefined && input.blockedBy.length > 0
        ? { blockedBy: input.blockedBy }
        : {}),
      ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
      raw: { local: true },
    };
    this.write(item);
    return item;
  }

  /** Reads one item by key (sync); throws if missing. */
  private readOne(key: string): NormalizedWorkItem {
    const file = this.fileFor(key);
    if (!existsSync(file)) {
      throw new Error(`local work item "${key}" not found`);
    }
    return normalizedWorkItemSchema.parse(
      JSON.parse(readFileSync(file, 'utf8')),
    ) as NormalizedWorkItem;
  }

  /** The next free rank in a lane (max + 1; 0 when empty). */
  private nextOrder(lane: WorkItemLane): number {
    const orders = this.readAll()
      .filter((i) => laneOf(i.status) === lane)
      .map((i) => i.order ?? 0);
    return orders.length === 0 ? 0 : Math.max(...orders) + 1;
  }

  /** Edits a local work item's fields (only provided keys change). */
  updateWorkItem(key: string, patch: UpdateWorkItemInput): NormalizedWorkItem {
    const item = this.readOne(key);
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.description !== undefined) item.description = patch.description;
    if (patch.labels !== undefined) item.labels = patch.labels;
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.priority !== undefined) item.priority = patch.priority;
    if (patch.assignee !== undefined) item.assignee = userFromName(patch.assignee);
    if (patch.parentExternalId !== undefined) item.parentExternalId = patch.parentExternalId;
    if (patch.order !== undefined) item.order = patch.order;
    if (patch.blockedBy !== undefined) item.blockedBy = patch.blockedBy;
    if (patch.estimate !== undefined) item.estimate = patch.estimate;
    if (patch.cycleOrSprint !== undefined) item.cycleOrSprint = patch.cycleOrSprint;
    item.updatedAt = this.now().toISOString();
    this.write(item);
    return item;
  }

  /** Deletes a local work item; returns false if it did not exist. */
  deleteWorkItem(key: string): boolean {
    const file = this.fileFor(key);
    if (!existsSync(file)) {
      return false;
    }
    unlinkSync(file);
    return true;
  }

  /** Moves an item to a lane (and rank): the kanban drag/move operation. */
  moveWorkItem(key: string, target: { lane: WorkItemLane; order?: number }): NormalizedWorkItem {
    const item = this.readOne(key);
    item.status = target.lane;
    item.order = target.order ?? this.nextOrder(target.lane);
    item.updatedAt = this.now().toISOString();
    this.write(item);
    return item;
  }

  /** Add / toggle / remove a user-authored checklist item; returns the updated item. */
  mutateChecklist(
    key: string,
    op:
      | { action: 'add'; text: string }
      | { action: 'toggle'; id: string }
      | { action: 'remove'; id: string },
  ): NormalizedWorkItem {
    const item = this.readOne(key);
    const list: NormalizedWorkItemChecklistItem[] = item.checklist ?? [];
    if (op.action === 'add') {
      const text = op.text.trim();
      if (text.length > 0) {
        let max = 0;
        for (const c of list) {
          const m = /^cl-(\d+)$/.exec(c.id);
          if (m) max = Math.max(max, Number.parseInt(m[1] as string, 10));
        }
        list.push({ id: `cl-${max + 1}`, text, done: false });
      }
    } else if (op.action === 'toggle') {
      const found = list.find((c) => c.id === op.id);
      if (found !== undefined) found.done = !found.done;
    } else {
      const i = list.findIndex((c) => c.id === op.id);
      if (i >= 0) list.splice(i, 1);
    }
    item.checklist = list;
    item.updatedAt = this.now().toISOString();
    this.write(item);
    return item;
  }

  /** The kanban board: every lane with its items in board order (rank, then key). */
  board(): WorkItemBoardLane[] {
    const all = this.readAll();
    return WORK_ITEM_LANES.map((lane) => ({
      lane,
      items: all
        .filter((i) => laneOf(i.status) === lane)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || keyNum(a.key) - keyNum(b.key)),
    }));
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
