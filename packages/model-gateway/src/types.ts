/**
 * Chat types and the model provider adapter contract (Build Contract §4.3).
 *
 * These shapes are shared with Excalibur Enterprise and the agent runtime:
 * renaming or removing a member is a breaking change.
 */

/**
 * A tool the model may request to call (function calling). `parameters` is a
 * JSON Schema object describing the tool's arguments. Additive (OSS, tool-loop
 * foundation) — adapters that receive `tools` map this to their wire format.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * A model's request to call a tool. `arguments` are already JSON-parsed into an
 * object — adapters tolerate string-or-object wire forms and surface a typed
 * error on malformed JSON rather than leaking a raw string into the loop.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * An image attached to a message for vision-capable models (P1.14). The URL may
 * be an `https://…` link or a `data:<mediaType>;base64,…` URL (e.g. a local file
 * encoded by the caller). Additive — text-only messages omit `images`.
 */
export interface ImagePart {
  url: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * Images to send alongside `content` to a vision-capable model (P1.14). The
   * `content` string stays the text part; adapters that support vision combine
   * the two into the provider's multimodal wire form. Text-only providers ignore
   * it. Additive — kept separate so `content` remains a plain string everywhere.
   */
  images?: ImagePart[];
  /**
   * Tool calls this assistant turn requested (when the model asked to call one
   * or more tools). Present only on `assistant` messages that requested tools.
   */
  toolCalls?: ToolCall[];
  /**
   * Identifies which tool call this message answers. Present only on `tool`
   * result messages; `content` carries the tool's textual result.
   */
  toolCallId?: string;
}

/**
 * How hard a reasoning-capable model should think (P1.14). Maps to the
 * provider's reasoning knob (OpenAI-style `reasoning_effort`, etc.). Additive —
 * omit it for non-reasoning models / default behavior.
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ChatInput {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Tools the model may request to call this turn (function calling). Optional
   * and additive — text-only requests omit it and behave exactly as before.
   */
  tools?: ToolSpec[];
  /**
   * Reasoning effort for a reasoning-capable model (P1.14). Adapters map it to
   * the provider's knob (e.g. OpenAI-compatible `reasoning_effort`). Additive —
   * omit for non-reasoning models. An explicit value overrides a provider's
   * configured reasoning-off `extraBody`.
   */
  reasoningEffort?: ReasoningEffort;
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

export type ChatFinishReason = 'stop' | 'length' | 'error' | 'tool_calls';

export interface ChatOutput {
  content: string;
  model: string;
  usage: ChatUsage;
  /** Cost in cents, `null` when no cost metadata is configured for the provider. */
  costCents: number | null;
  finishReason: ChatFinishReason;
  /**
   * Tool calls the model requested this turn. Present (and `finishReason` is
   * `'tool_calls'`) when the model asked to call one or more tools; `content`
   * may be empty on such a turn. Absent on text-only completions.
   */
  toolCalls?: ToolCall[];
}

export interface ChatDelta {
  content: string;
  done: boolean;
  /**
   * Provider-reported usage carried on the stream when available (e.g. an
   * Anthropic `message_start`/`message_delta`, or an OpenAI `include_usage`
   * final chunk). Partial — input and output tokens may arrive on separate
   * deltas. Consumers prefer this over estimating from text.
   */
  usage?: Partial<ChatUsage>;
}

export interface ModelProviderAdapter {
  readonly name: string;
  chat(input: ChatInput): Promise<ChatOutput>;
  stream(input: ChatInput): AsyncIterable<ChatDelta>;
}
