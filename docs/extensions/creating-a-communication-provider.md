# Creating a Communication Provider

A communication provider posts Excalibur output — run summaries, discovery
results, daily reports — to chat platforms (Slack, Microsoft Teams, Discord)
and reads thread replies back. It is a **programmatic** extension
implementing the `CommunicationProvider` interface owned by
`@excalibur/extension-sdk`.

## The interface

```ts
import type {
  CommunicationProvider,
  PostMessageInput, // { channelId, markdown, blocks? }
  PostThreadReplyInput, // { channelId, threadId, markdown, blocks? }
  GetThreadRepliesInput, // { channelId, threadId }
  PostMessageResult, // { externalMessageId, threadId?, url? }
  ThreadReply, // { externalMessageId, body, authorName?, createdAt? }
} from '@excalibur/extension-sdk';

export class SlackProvider implements CommunicationProvider {
  readonly type = 'slack'; // stable provider type id

  async postMessage(input: PostMessageInput): Promise<PostMessageResult> {
    // Convert markdown to the platform's native format; return the created
    // message id and (when threading is supported) the thread id.
  }
  async postThreadReply(input: PostThreadReplyInput): Promise<PostMessageResult> {
    /* … */
  }
  async getThreadReplies(input: GetThreadRepliesInput): Promise<ThreadReply[]> {
    /* … */
  }
  async validateCredentials(): Promise<boolean> {
    /* cheap auth check */
  }
}
```

Guidelines:

- `markdown` is the canonical body; convert to Block Kit / Adaptive Cards in
  the provider. `blocks` is an optional provider-native escape hatch.
- Return stable `externalMessageId`/`threadId` values — Excalibur uses them
  to thread follow-ups.
- Throw `ProviderError` (from `@excalibur/shared`) on API failures; redact
  tokens from error messages.

## Register it

```ts
import { defineExtension } from '@excalibur/extension-sdk';
import { SlackProvider } from './provider';

export default defineExtension({
  id: 'slack',
  name: 'Slack',
  version: '0.1.0',
  register(ctx) {
    ctx.communication.registerProvider(new SlackProvider());

    // Typical pairing: post when runs finish.
    ctx.hooks.on<{ runId: string }>('run.completed', async (event) => {
      ctx.logger.info(`run ${event.runId} completed — posting summary`);
      // post via your provider here
    });
  },
});
```

`registerProvider` validates the shape (non-empty `type`, the four methods)
and registers a `communication_provider` contribution.

## The manifest

```yaml
id: slack
name: Slack
version: 0.1.0
kind: programmatic
entrypoint: dist/index.js
contributes:
  communicationProviders:
    - slack
capabilities:
  - communication.post
configSchema:
  botTokenEnv: { type: string, required: true } # env var NAME only
  defaultChannel: { type: string, required: false }
permissions:
  network:
    allowedHosts: [slack.com, api.slack.com]
  secrets:
    env: [SLACK_BOT_TOKEN]
```

## Scaffold, build, validate

```bash
excalibur extensions create communication-provider slack
cd .excalibur/extensions/slack && npm install && npm run build
excalibur extensions validate
```

## Honest M1 status

The interface is stable and your provider loads and validates today, but the
M1 mock loop never posts to chat platforms — communication flows (Slack-first
discovery, run notifications) activate in a later milestone alongside the
hosted webhook surface. Implement and unit-test now; wire-up comes with that
milestone.
