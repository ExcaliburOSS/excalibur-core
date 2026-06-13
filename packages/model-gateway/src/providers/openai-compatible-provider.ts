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
import { parseSSE } from '../transport/sse';
import type { TransportRequest, TransportResponse } from '../transport/transport';
import type { ChatFinishReason, ChatInput, ChatUsage } from '../types';
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
  // stop, tool_calls, content_filter, null → stop.
  return 'stop';
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
    super({ ...options, requiresApiKey: true });
    if (this.cfg.baseUrl === undefined || this.cfg.baseUrl.length === 0) {
      throw new ConfigValidationError(
        `Provider "${options.name}" (type "${options.cfg.type}") requires "baseUrl" in providers.yaml (e.g. an OpenAI-compatible endpoint).`,
        { provider: options.name, type: options.cfg.type },
      );
    }
    this.url = chatCompletionsUrl(this.cfg.baseUrl);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey ?? ''}`,
      'content-type': 'application/json',
    };
    if (this.cfg.organization !== undefined && this.cfg.organization.length > 0) {
      headers['openai-organization'] = this.cfg.organization;
    }
    return headers;
  }

  private body(input: ChatInput, model: string, stream: boolean): string {
    const payload: Record<string, unknown> = {
      model,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream,
    };
    if (input.temperature !== undefined) {
      payload['temperature'] = input.temperature;
    }
    if (input.maxTokens !== undefined) {
      payload['max_tokens'] = input.maxTokens;
    }
    if (stream) {
      payload['stream_options'] = { include_usage: true };
    }
    return JSON.stringify(payload);
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
        message?: { content?: string };
        finish_reason?: unknown;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const choice = obj.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
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
