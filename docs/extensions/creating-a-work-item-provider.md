# Creating a Work-Item Provider

A work-item provider connects Excalibur to a ticket system (Linear, Jira,
GitHub Issues, …). It is a **programmatic** extension: code that talks to an
external API behind the normalized `WorkItemProvider` interface from
`@excalibur/work-items`.

## The interface

```ts
import type {
  WorkItemProvider,
  GetWorkItemInput,            // { integrationId, externalIdOrKey }
  ListWorkItemsInput,          // { integrationId, query?, status?, assignee?, project?, team?, labels?, limit? }
  AddWorkItemCommentInput,     // { integrationId, externalIdOrKey, body }
  UpdateWorkItemStatusInput,   // { integrationId, externalIdOrKey, status }
  LinkPullRequestInput,        // { integrationId, externalIdOrKey, pullRequest: { provider, url, title, … } }
  NormalizedWorkItem,
} from '@excalibur/work-items';

export class LinearWorkItemProvider implements WorkItemProvider {
  readonly type = 'linear';    // one of: linear | jira | github_issues | gitlab_issues | azure_devops | asana | youtrack

  async getWorkItem(input: GetWorkItemInput): Promise<NormalizedWorkItem> { /* … */ }
  async listWorkItems(input: ListWorkItemsInput): Promise<NormalizedWorkItem[]> { /* … */ }
  async addComment(input: AddWorkItemCommentInput): Promise<void> { /* … */ }
  async updateStatus(input: UpdateWorkItemStatusInput): Promise<void> { /* … */ }
  async linkPullRequest(input: LinkPullRequestInput): Promise<void> { /* … */ }
  async validateCredentials(): Promise<boolean> { /* cheap auth check */ }
}
```

Map your system's fields into `NormalizedWorkItem` (schema
`normalizedWorkItemSchema` in `@excalibur/work-items`) — that is the shape
the rest of Excalibur consumes. Throw `ProviderError` (from
`@excalibur/shared`) for API failures; never log secrets.

## Register it

```ts
// src/index.ts
import { defineExtension } from '@excalibur/extension-sdk';
import { LinearWorkItemProvider } from './provider';

export default defineExtension({
  id: 'linear',
  name: 'Linear',
  version: '0.1.0',
  register(ctx) {
    const apiKeyEnv =
      typeof ctx.config['apiKeyEnv'] === 'string' ? ctx.config['apiKeyEnv'] : 'LINEAR_API_KEY';
    ctx.workItems.registerProvider(new LinearWorkItemProvider({ apiKeyEnv }));
  },
});
```

`registerProvider` checks the provider shape (non-empty `type`, all six
methods present) and registers it as a `work_item_provider` contribution.

## The manifest

```yaml
id: linear
name: Linear
version: 0.1.0
kind: programmatic
entrypoint: dist/index.js
contributes:
  workItemProviders:
    - linear
capabilities:
  - work_items.read
  - work_items.comment
  - work_items.update_status
  - work_items.link_pr
configSchema:
  apiKeyEnv: { type: string, required: true }   # env var NAME, never the value
  workspace: { type: string, required: false }
permissions:
  network:
    allowedHosts: [api.linear.app]
  secrets:
    env: [LINEAR_API_KEY]
```

## Scaffold, build, install

```bash
excalibur extensions create work-item-provider linear
cd .excalibur/extensions/linear && npm install && npm run build
excalibur extensions validate
excalibur extensions doctor
```

## Honest M1 status

The loader loads and validates your provider today, and `MockWorkItemProvider`
(in `@excalibur/work-items`) shows the expected behavior and is ideal for
tests. But the M1 mock loop does not call work-item APIs during runs —
webhook/comment-driven flows (`@excalibur refine` on a ticket, etc.) activate
with the work-items milestone (M4). Build and test the provider now; it
starts being exercised then.

See [testing-extensions.md](./testing-extensions.md) for testing patterns and
[security-model.md](./security-model.md) for credential rules.
