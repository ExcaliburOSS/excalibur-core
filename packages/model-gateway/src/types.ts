/**
 * Chat types and the model provider adapter contract (Build Contract §4.3).
 *
 * These shapes are shared with Excalibur Enterprise and the agent runtime:
 * renaming or removing a member is a breaking change.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatInput {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
  /**
   * Per-request timeout in milliseconds for real provider adapters (OSS-4, M2).
   * Overrides the provider's configured `timeoutMs`. Ignored by the mock
   * provider. Optional and additive — existing callers are unaffected.
   */
  timeoutMs?: number;
  /**
   * Caller-supplied abort signal for real provider adapters (OSS-4, M2).
   * Aborting cancels the in-flight HTTP request. Ignored by the mock provider.
   * Optional and additive — existing callers are unaffected.
   */
  signal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ChatFinishReason = 'stop' | 'length' | 'error';

export interface ChatOutput {
  content: string;
  model: string;
  usage: ChatUsage;
  /** Cost in cents, `null` when no cost metadata is configured for the provider. */
  costCents: number | null;
  finishReason: ChatFinishReason;
}

export interface ChatDelta {
  content: string;
  done: boolean;
}

export interface ModelProviderAdapter {
  readonly name: string;
  chat(input: ChatInput): Promise<ChatOutput>;
  stream(input: ChatInput): AsyncIterable<ChatDelta>;
}
