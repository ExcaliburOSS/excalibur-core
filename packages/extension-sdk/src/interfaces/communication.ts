/**
 * Communication provider contract (extensions-spec.md §5).
 *
 * Implemented by programmatic extensions that post Excalibur output (run
 * summaries, discovery results, daily reports, …) to chat platforms such as
 * Slack, Microsoft Teams or Discord. M1 ships no real provider; the interface
 * is the stable surface extensions code against.
 */

/** Input for posting a new top-level message to a channel. */
export interface PostMessageInput {
  /** Provider-native channel identifier (e.g. a Slack channel id). */
  channelId: string;
  /** Message body as markdown; providers convert to their native format. */
  markdown: string;
  /** Optional provider-native rich blocks (e.g. Slack Block Kit). */
  blocks?: unknown[];
}

/** Input for posting a reply inside an existing thread. */
export interface PostThreadReplyInput {
  channelId: string;
  /** Provider-native thread identifier returned by `postMessage`. */
  threadId: string;
  markdown: string;
  blocks?: unknown[];
}

/** Input for reading the replies of an existing thread. */
export interface GetThreadRepliesInput {
  channelId: string;
  threadId: string;
}

/** Result of posting a message or thread reply. */
export interface PostMessageResult {
  /** Provider-native id of the created message. */
  externalMessageId: string;
  /** Thread the message belongs to (or starts), when threading is supported. */
  threadId?: string;
  /** Permalink to the message, when the provider exposes one. */
  url?: string;
}

/** A single reply read from a thread. */
export interface ThreadReply {
  externalMessageId: string;
  /** Reply body (markdown or plain text as returned by the provider). */
  body: string;
  authorName?: string;
  /** ISO 8601 creation timestamp, when available. */
  createdAt?: string;
}

export interface CommunicationProvider {
  /** Stable provider type id (e.g. `slack`, `teams`, `discord`). */
  type: string;
  postMessage(input: PostMessageInput): Promise<PostMessageResult>;
  postThreadReply(input: PostThreadReplyInput): Promise<PostMessageResult>;
  getThreadReplies(input: GetThreadRepliesInput): Promise<ThreadReply[]>;
  /** Resolves `true` when the configured credentials are usable. */
  validateCredentials(): Promise<boolean>;
}
