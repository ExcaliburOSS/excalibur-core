import type {
  AddWorkItemCommentInput,
  GetWorkItemInput,
  LinkPullRequestInput,
  ListWorkItemsInput,
  UpdateWorkItemStatusInput,
  WorkItemProvider,
} from './provider';
import type {
  NormalizedWorkItem,
  NormalizedWorkItemComment,
  NormalizedWorkItemUser,
} from './types';

/**
 * GitHub Issues work-item provider via the `gh` CLI passthrough (plan P2.9 / the
 * OSS BYO-auth path). It shells out to an already-authenticated `gh`, so OSS
 * users get a REAL GitHub provider with zero token handling by Excalibur (gh
 * holds the credential) — the same passthrough philosophy as the agent adapters.
 * Enterprise gets the server-side App provider (M4).
 *
 * The `gh` invocation is injected ({@link GhRunner}) so the mapping is unit
 * tested against fixture JSON without the network.
 */

/** Runs `gh <args>` and resolves stdout. Throws on a non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

interface GhIssue {
  number: number;
  title: string;
  state?: string;
  body?: string;
  url?: string;
  labels?: Array<{ name?: string }>;
  author?: { login?: string } | null;
  assignees?: Array<{ login?: string }>;
  createdAt?: string;
  updatedAt?: string;
  comments?: Array<{ author?: { login?: string } | null; body?: string; createdAt?: string }>;
}

const LIST_FIELDS = 'number,title,state,labels,author,assignees,url,createdAt,updatedAt';
const VIEW_FIELDS = `${LIST_FIELDS},body,comments`;

function user(login: string | undefined | null): NormalizedWorkItemUser | null {
  return login !== undefined && login !== null && login.length > 0
    ? { externalId: login, name: login, email: null, username: login }
    : null;
}

function mapComment(raw: NonNullable<GhIssue['comments']>[number]): NormalizedWorkItemComment {
  return {
    externalId: `${raw.createdAt ?? ''}-${raw.author?.login ?? ''}`,
    body: raw.body ?? '',
    author: user(raw.author?.login),
    createdAt: raw.createdAt ?? null,
    updatedAt: null,
    raw,
  };
}

/** Maps a `gh issue` JSON object to a NormalizedWorkItem. */
export function mapGhIssue(raw: GhIssue, repo: string): NormalizedWorkItem {
  return {
    provider: 'github_issues',
    externalId: String(raw.number),
    key: `${repo}#${raw.number}`,
    url: raw.url ?? `https://github.com/${repo}/issues/${raw.number}`,
    title: raw.title,
    description: raw.body ?? null,
    // gh reports OPEN/CLOSED; normalize to lowercase for the contract.
    status: raw.state !== undefined ? raw.state.toLowerCase() : null,
    priority: null,
    labels: (raw.labels ?? []).map((l) => l.name ?? '').filter((n) => n.length > 0),
    assignee: user(raw.assignees?.[0]?.login),
    reporter: user(raw.author?.login),
    project: null,
    team: null,
    cycleOrSprint: null,
    parentExternalId: null,
    comments: (raw.comments ?? []).map(mapComment),
    links: [],
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    raw,
  };
}

export class GitHubCliProvider implements WorkItemProvider {
  readonly type = 'github_issues' as const;

  /**
   * @param run  injected `gh` executor (default shells out to the real `gh`).
   * @param repo `owner/name`; omitted → gh uses the current repo's remote.
   */
  constructor(
    private readonly run: GhRunner,
    private readonly repo?: string,
  ) {}

  private repoArgs(): string[] {
    return this.repo !== undefined ? ['--repo', this.repo] : [];
  }

  private repoLabel(): string {
    return this.repo ?? '.';
  }

  async getWorkItem(input: GetWorkItemInput): Promise<NormalizedWorkItem> {
    const out = await this.run([
      'issue',
      'view',
      input.externalIdOrKey,
      '--json',
      VIEW_FIELDS,
      ...this.repoArgs(),
    ]);
    return mapGhIssue(JSON.parse(out) as GhIssue, this.repoLabel());
  }

  async listWorkItems(input: ListWorkItemsInput): Promise<NormalizedWorkItem[]> {
    const args = ['issue', 'list', '--json', LIST_FIELDS, '--limit', String(input.limit ?? 30)];
    // gh supports --state open|closed|all; forward all three (omitting it would
    // default gh to open-only, silently dropping `all`).
    if (input.status === 'open' || input.status === 'closed' || input.status === 'all') {
      args.push('--state', input.status);
    }
    if (input.assignee !== undefined) args.push('--assignee', input.assignee);
    if (input.labels !== undefined && input.labels.length > 0) {
      args.push('--label', input.labels.join(','));
    }
    if (input.query !== undefined && input.query.length > 0) args.push('--search', input.query);
    const out = await this.run([...args, ...this.repoArgs()]);
    const issues = JSON.parse(out) as GhIssue[];
    return issues.map((issue) => mapGhIssue(issue, this.repoLabel()));
  }

  async addComment(input: AddWorkItemCommentInput): Promise<void> {
    await this.run([
      'issue',
      'comment',
      input.externalIdOrKey,
      '--body',
      input.body,
      ...this.repoArgs(),
    ]);
  }

  async updateStatus(input: UpdateWorkItemStatusInput): Promise<void> {
    // GitHub issues are only open/closed. Close on a terminal status; reopen ONLY
    // on an explicit open/reopen status. A non-terminal status (in_progress, todo,
    // backlog, in review, …) is a NO-OP — it must never flip a closed issue back
    // open (which would fire 'reopened' webhooks out of nowhere).
    if (/clos|done|resolv|complete/i.test(input.status)) {
      await this.run(['issue', 'close', input.externalIdOrKey, ...this.repoArgs()]);
    } else if (/^(re)?open/i.test(input.status.trim())) {
      await this.run(['issue', 'reopen', input.externalIdOrKey, ...this.repoArgs()]);
    }
    // else: non-terminal status → do nothing.
  }

  async linkPullRequest(input: LinkPullRequestInput): Promise<void> {
    // GitHub has no formal issue↔PR link API beyond closing keywords; the
    // convention is a comment referencing the PR (which GitHub auto-links).
    await this.run([
      'issue',
      'comment',
      input.externalIdOrKey,
      '--body',
      `Linked pull request: ${input.pullRequest.url}`,
      ...this.repoArgs(),
    ]);
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.run(['auth', 'status']);
      return true;
    } catch {
      return false;
    }
  }
}
