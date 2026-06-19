# Work Item Integrations — Excalibur Core scope

The Work Item Integrations extension lets Excalibur start work from Linear, Jira, GitHub Issues and GitLab Issues:

```text
Linear issue / Jira ticket / GitHub issue / GitLab issue
        ↓
Excalibur interaction / patch / run
        ↓
branch / diff / tests / PR / review
        ↓
status and PR link synced back to the original work item
```

Excalibur Core owns the **normalized abstraction** (this document). Excalibur Enterprise owns credentials, webhooks, sync, cache, permissions and governance. OSS local integrations and Enterprise app integrations must share the same normalized provider concepts even if authentication and sync differ.

This package (`packages/work-items`) implements, in M1: the types, the provider interface, the command parser, the comment templates and a deterministic `mock` provider. Real HTTP providers (GitHub Issues, Linear, Jira) arrive in later milestones.

---

## 1. Provider abstraction

```ts
export type WorkItemProviderType =
  | 'linear'
  | 'jira'
  | 'github_issues'
  | 'gitlab_issues'
  | 'shortcut'
  | 'azure_devops'
  | 'youtrack';

export interface WorkItemProvider {
  type: WorkItemProviderType;
  getWorkItem(input: GetWorkItemInput): Promise<NormalizedWorkItem>;
  listWorkItems(input: ListWorkItemsInput): Promise<NormalizedWorkItem[]>;
  addComment(input: AddWorkItemCommentInput): Promise<void>;
  updateStatus(input: UpdateWorkItemStatusInput): Promise<void>;
  linkPullRequest(input: LinkPullRequestInput): Promise<void>;
  validateCredentials(): Promise<boolean>;
}
```

NOTE (implementation decision): a `mock` provider implementing this interface ships in M1 for demos/tests; its `type` is one of the real provider types passed at construction, with deterministic in-memory data.

## 2. Normalized work item model

```ts
export type NormalizedWorkItem = {
  provider: WorkItemProviderType;
  externalId: string;
  key: string;
  url: string;
  title: string;
  description: string | null;
  status: string | null;
  priority: string | null;
  labels: string[];
  assignee: NormalizedWorkItemUser | null;
  reporter: NormalizedWorkItemUser | null;
  project: string | null;
  team: string | null;
  cycleOrSprint: string | null;
  parentExternalId: string | null;
  comments: NormalizedWorkItemComment[];
  links: NormalizedWorkItemLink[];
  createdAt: string | null;
  updatedAt: string | null;
  raw: unknown;
};

export type NormalizedWorkItemUser = {
  externalId: string | null;
  name: string | null;
  email: string | null;
  username: string | null;
};

export type NormalizedWorkItemComment = {
  externalId: string;
  body: string;
  author: NormalizedWorkItemUser | null;
  createdAt: string | null;
  updatedAt: string | null;
  raw: unknown;
};

export type NormalizedWorkItemLink = {
  type: 'pull_request' | 'commit' | 'document' | 'url' | 'issue' | 'other';
  url: string;
  title: string | null;
  raw: unknown;
};
```

## 3. Input/output types

```ts
export type GetWorkItemInput = { integrationId: string; externalIdOrKey: string };

export type ListWorkItemsInput = {
  integrationId: string;
  query?: string;
  status?: string;
  assignee?: string;
  project?: string;
  team?: string;
  labels?: string[];
  limit?: number;
};

export type AddWorkItemCommentInput = {
  integrationId: string;
  externalIdOrKey: string;
  body: string;
};

export type UpdateWorkItemStatusInput = {
  integrationId: string;
  externalIdOrKey: string;
  status: string;
};

export type LinkPullRequestInput = {
  integrationId: string;
  externalIdOrKey: string;
  pullRequest: {
    provider: 'github' | 'gitlab' | 'bitbucket';
    url: string;
    title: string;
    number?: number;
    repositoryFullName?: string;
  };
};
```

## 4. Command parsing

Common parser for ticket/issue/Slack-thread comments. Supported commands:

```text
@excalibur refine
@excalibur plan
@excalibur review
@excalibur suggest-patch
@excalibur generate-tests
@excalibur implement
@excalibur careful
@excalibur explore
@excalibur status
@excalibur cancel
```

Agentic Agile commands (same parser):

```text
@excalibur daily
@excalibur planning start
@excalibur planning propose
@excalibur planning approve
@excalibur planning revise
@excalibur planning add ENG-123
@excalibur planning remove ENG-123
@excalibur planning owner ENG-123 @rafael
@excalibur planning careful ENG-123
@excalibur planning run ENG-123
```

Command → action mapping (used by Enterprise):

| Command        | Creates                                                               | autonomyLevel / notes            |
| -------------- | --------------------------------------------------------------------- | -------------------------------- |
| refine         | AssistantInteraction `work_item_refinement`                           | 0                                |
| plan           | AssistantInteraction `work_item_plan`                                 | 0                                |
| review         | AssistantInteraction `work_item_review`                               | 0                                |
| suggest-patch  | PatchRequest                                                          | 2                                |
| generate-tests | PatchRequest (default) or AgentRun per config                         | 2 / 3                            |
| implement      | AgentRun                                                              | 3, executionStyle `team_default` |
| careful        | AgentRun                                                              | 4, executionStyle `careful`      |
| explore        | AssistantInteraction (alternatives) by default, AgentRun if requested | —                                |
| status         | comment with linked runs/patches/interactions                         | —                                |
| cancel         | cancel active run if permitted                                        | —                                |

Optional flags: `--repo <name>`, `--branch <name>`, `--workflow <key>`, `--output <type>`, plus bare flags such as `--branch` on generate-tests. Examples:

```text
@excalibur implement --repo quickcontract-api --branch main
@excalibur careful --workflow structured-feature
@excalibur explore --output alternatives
@excalibur generate-tests --branch
```

## 5. Comment templates

Templates rendered with `{{variable}}` placeholders:

**run_started**

```text
Excalibur started an agentic run.

Task: {{title}}
Repository: {{repository}}
Workflow: {{workflow}}
Autonomy: {{autonomyLevelLabel}}
Execution: {{executionStyle}}

Run: {{runUrl}}
```

**plan_generated**

```text
Excalibur generated an implementation plan.

{{planSummary}}

Run/Interaction: {{url}}
```

**patch_suggested**

```text
Excalibur generated a patch suggestion.

Files affected:
{{filesAffected}}

Summary:
{{summary}}

Patch: {{patchUrl}}
```

**pr_opened**

```text
Excalibur opened a pull request.

PR: {{pullRequestUrl}}
Run: {{runUrl}}

Summary:
{{summary}}
```

**run_failed**

```text
Excalibur run failed.

Reason:
{{reason}}

Run: {{runUrl}}
```

**need_repository**

```text
Excalibur needs a target repository before it can continue.

Please use:
@excalibur implement --repo <repository-name>
```

**identity_not_verified**

```text
Excalibur could not verify your identity. Please connect your Excalibur account before running this command.
```

## 6. OSS CLI integration (later milestone, WI-7)

Lightweight local integrations via API tokens (no OAuth/app installs in OSS):

```bash
excalibur linear issue ENG-123 | refine | plan | patch | run
excalibur jira issue PROJ-123 | refine | plan | patch | run
excalibur github issue 123 | plan | patch | run
```

Local config (`.excalibur/config.yaml`):

```yaml
integrations:
  linear:
    apiKeyEnv: LINEAR_API_KEY
    workspace: my-workspace
  jira:
    baseUrl: https://company.atlassian.net
    emailEnv: JIRA_EMAIL
    apiTokenEnv: JIRA_API_TOKEN
  github:
    tokenEnv: GITHUB_TOKEN
    owner: acme
    repo: quickcontract-api
```

OSS behavior: fetch issue → convert to NormalizedWorkItem → use as context → create local interaction/patch/run → optionally create PR through `gh`. No centralized status sync by default.
