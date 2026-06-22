/**
 * OpenAI-compatible chat-completions adapter
 * (`POST {baseUrl}/v1/chat/completions`).
 *
 * Covers MiniMax, Qwen, DeepSeek, vLLM, OpenRouter and any other endpoint that
 * speaks the OpenAI chat-completions wire format. `baseUrl` is required.
 *
 * Wire shape:
 *   headers: authorization: Bearer <key>, optional openai-organization
 *   body:    { model, messages, temperature?, max_tokens?, stream?,
 *              stream_options: { include_usage: true } when streaming }
 *   response: choices[0].message.content; usage.prompt_tokens/completion_tokens;
 *             choices[0].finish_reason → finishReason.
 *   stream (SSE, terminated by `data: [DONE]`): choices[0].delta.content;
 *             a trailing chunk's `usage` when include_usage is honored.
 */

import { ConfigValidationError, ProviderError } from '@excalibur/shared';
import { parseToolArguments } from '../errors/provider-errors';
import { parseSSE } from '../transport/sse';
import type { TransportRequest, TransportResponse } from '../transport/transport';
import type { ChatFinishReason, ChatInput, ChatMessage, ChatUsage, ToolCall } from '../types';
import {
  BaseHttpProvider,
  type BaseHttpProviderOptions,
  type ParsedChatResponse,
  type StreamEvent,
} from './base-http-provider';

function mapFinishReason(reason: unknown): ChatFinishReason {
  if (reason === 'length') {
    return 'length';
  }
  if (reason === 'tool_calls') {
    return 'tool_calls';
  }
  // stop, content_filter, null → stop.
  return 'stop';
}

/**
 * Serializes one normalized message into the OpenAI chat-completions wire form.
 * Tool-calling turns map as:
 *   - assistant with `toolCalls` → `{role:'assistant', content,
 *     tool_calls:[{id, type:'function', function:{name, arguments}}]}`
 *     (`arguments` is a JSON string, per the wire format);
 *   - a `tool` result message → `{role:'tool', tool_call_id, content}`.
 */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? '',
      content: message.content,
    };
  }
  if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
  }
  // Vision (P1.14): a message with images becomes the OpenAI multimodal content
  // array — the text part plus one `image_url` part per image (URL or data: URL).
  // Only user/assistant carry images; text-only messages keep a plain string.
  if (message.images !== undefined && message.images.length > 0) {
    const parts: Array<Record<string, unknown>> = [];
    if (message.content.length > 0) {
      parts.push({ type: 'text', text: message.content });
    }
    for (const image of message.images) {
      parts.push({ type: 'image_url', image_url: { url: image.url } });
    }
    return { role: message.role, content: parts };
  }
  return { role: message.role, content: message.content };
}

/** Joins `{baseUrl}` and the chat-completions path without doubling `/v1`. */
function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

export class OpenAICompatibleAdapter extends BaseHttpProvider {
  private readonly url: string;

  constructor(options: Omit<BaseHttpProviderOptions, 'requiresApiKey'>) {
    // A key is required ONLY when `apiKeyEnv` is configured. A self-hosted /
    // own-infra endpoint (vLLM, TGI, an internal Qwen gateway) that needs no
    // auth omits `apiKeyEnv` and runs keyless — Excalibur must support that.
    const requiresApiKey = (options.cfg.apiKeyEnv ?? '').length > 0;
    super({ ...options, requiresApiKey });
    if (this.cfg.baseUrl === undefined || this.cfg.baseUrl.length === 0) {
      throw new ConfigValidationError(
        `Provider "${options.name}" (type "${options.cfg.type}") requires "baseUrl" in providers.yaml (e.g. an OpenAI-compatible endpoint).`,
        { provider: options.name, type: options.cfg.type },
      );
    }
    this.url = chatCompletionsUrl(this.cfg.baseUrl);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Send the bearer token ONLY when there is a key — a keyless self-hosted
    // endpoint gets no auth header (some reject an empty `Bearer `).
    if (this.apiKey !== null) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    if (this.cfg.organization !== undefined && this.cfg.organization.length > 0) {
      headers['openai-organization'] = this.cfg.organization;
    }
    return headers;
  }

  private body(input: ChatInput, model: string, stream: boolean): string {
    const payload: Record<string, unknown> = {
      model,
      messages: input.messages.map(toWireMessage),
      stream,
    };
    if (input.temperature !== undefined) {
      payload['temperature'] = input.temperature;
    }
    if (input.maxTokens !== undefined) {
      payload['max_tokens'] = input.maxTokens;
    }
    if (input.tools !== undefined && input.tools.length > 0) {
      payload['tools'] = input.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    // Reasoning effort (P1.14): the OpenAI-compatible knob for reasoning models.
    // An explicit request value wins over a provider's reasoning-off `extraBody`
    // because `payload` is merged OVER `extra` below.
    if (input.reasoningEffort !== undefined) {
      payload['reasoning_effort'] = input.reasoningEffort;
    }
    if (stream) {
      payload['stream_options'] = { include_usage: true };
    }
    // Merge configured `extraBody` UNDER the core fields: it adds pinned per-
    // provider knobs (chiefly reasoning-off for the fast/`cheap` role, e.g.
    // {reasoning_effort:'none'} or {thinking:{type:'disabled'}}) but can never
    // clobber model/messages/stream/tools.
    const extra = this.cfg.extraBody;
    return JSON.stringify(extra !== undefined ? { ...extra, ...payload } : payload);
  }

  protected buildChatRequest(input: ChatInput, model: string): TransportRequest {
    return {
      url: this.url,
      method: 'POST',
      headers: this.headers(),
      body: this.body(input, model, false),
    };
  }

  protected buildStreamRequest(input: ChatInput, model: string): TransportRequest {
    return {
      url: this.url,
      method: 'POST',
      headers: this.headers(),
      body: this.body(input, model, true),
    };
  }

  protected parseChatResponse(text: string, model: string): ParsedChatResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProviderError('OpenAI-compatible response was not valid JSON.', {
        code: 'invalid_request',
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    const obj = parsed as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: unknown };
          }>;
        };
        finish_reason?: unknown;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const choice = obj.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const toolCalls: ToolCall[] = [];
    (choice?.message?.tool_calls ?? []).forEach((call, index) => {
      const name = typeof call.function?.name === 'string' ? call.function.name : '';
      toolCalls.push({
        // OpenAI normally sends an id; synthesize a stable one from the call's
        // position when it is missing/empty so the result round-trip never
        // carries an empty tool_call_id.
        id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${index}`,
        name,
        // OpenAI returns `arguments` as a JSON string; malformed JSON surfaces
        // a typed error rather than crashing the loop downstream.
        arguments: parseToolArguments(name, call.function?.arguments),
      });
    });
    const usage: Partial<ChatUsage> = {};
    if (typeof obj.usage?.prompt_tokens === 'number') {
      usage.inputTokens = obj.usage.prompt_tokens;
    }
    if (typeof obj.usage?.completion_tokens === 'number') {
      usage.outputTokens = obj.usage.completion_tokens;
    }
    return {
      content,
      usage,
      finishReason: mapFinishReason(choice?.finish_reason),
      model: typeof obj.model === 'string' && obj.model.length > 0 ? obj.model : model,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  protected async *decodeStream(
    response: TransportResponse,
    _input: ChatInput,
    _model: string,
  ): AsyncIterable<StreamEvent> {
    for await (const message of parseSSE(response.lines())) {
      const data = message.data;
      if (data === '') {
        continue;
      }
      if (data === '[DONE]') {
        return;
      }
      let chunk: {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { content: delta };
      }
      if (chunk.usage !== undefined && chunk.usage !== null) {
        const usage: Partial<ChatUsage> = {};
        if (typeof chunk.usage.prompt_tokens === 'number') {
          usage.inputTokens = chunk.usage.prompt_tokens;
        }
        if (typeof chunk.usage.completion_tokens === 'number') {
          usage.outputTokens = chunk.usage.completion_tokens;
        }
        if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
          yield { content: '', usage };
        }
      }
    }
  }
}
