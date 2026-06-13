/**
 * Anthropic Messages API adapter (`POST {baseUrl}/v1/messages`).
 *
 * Wire shape (Anthropic Messages API):
 *   headers: x-api-key, anthropic-version, content-type
 *   body:    { model, max_tokens, system?, messages, temperature?, stream? }
 *   response: content[].text joined; usage.input_tokens/output_tokens;
 *             stop_reason → finishReason.
 *   stream (SSE): message_start (input usage) → content_block_delta (text) →
 *             message_delta (output usage + stop_reason) → message_stop.
 *
 * The `model` string comes entirely from provider config / request input — the
 * adapter is model-agnostic and never hardcodes a model id.
 */

import { ProviderError } from '@excalibur/shared';
import { parseSSE } from '../transport/sse';
import type { TransportRequest, TransportResponse } from '../transport/transport';
import type { ChatFinishReason, ChatInput, ChatMessage, ChatUsage } from '../types';
import {
  BaseHttpProvider,
  type BaseHttpProviderOptions,
  type ParsedChatResponse,
  type StreamEvent,
} from './base-http-provider';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

function mapStopReason(stopReason: unknown): ChatFinishReason {
  if (stopReason === 'max_tokens') {
    return 'length';
  }
  // end_turn, tool_use, stop_sequence, null → stop.
  return 'stop';
}

/** Splits messages into the top-level `system` string and user/assistant turns. */
function splitSystem(messages: ChatMessage[]): {
  system: string | undefined;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
    } else {
      turns.push({ role: message.role, content: message.content });
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    turns,
  };
}

export class AnthropicAdapter extends BaseHttpProvider {
  private readonly baseUrl: string;
  private readonly apiVersion: string;

  constructor(options: Omit<BaseHttpProviderOptions, 'requiresApiKey'>) {
    super({ ...options, requiresApiKey: true });
    this.baseUrl = (this.cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiVersion = this.cfg.apiVersion ?? DEFAULT_API_VERSION;
  }

  private endpoint(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  private headers(): Record<string, string> {
    return {
      // apiKey is guaranteed non-null: requiresApiKey is true.
      'x-api-key': this.apiKey ?? '',
      'anthropic-version': this.apiVersion,
      'content-type': 'application/json',
    };
  }

  private body(input: ChatInput, model: string, stream: boolean): string {
    const { system, turns } = splitSystem(input.messages);
    const payload: Record<string, unknown> = {
      model,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: turns,
      stream,
    };
    if (system !== undefined) {
      payload['system'] = system;
    }
    if (input.temperature !== undefined) {
      payload['temperature'] = input.temperature;
    }
    return JSON.stringify(payload);
  }

  protected buildChatRequest(input: ChatInput, model: string): TransportRequest {
    return {
      url: this.endpoint(),
      method: 'POST',
      headers: this.headers(),
      body: this.body(input, model, false),
    };
  }

  protected buildStreamRequest(input: ChatInput, model: string): TransportRequest {
    return {
      url: this.endpoint(),
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
      throw new ProviderError('Anthropic response was not valid JSON.', {
        code: 'invalid_request',
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    const obj = parsed as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: unknown;
      model?: string;
    };
    const content = (obj.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('');
    const usage: Partial<ChatUsage> = {};
    if (typeof obj.usage?.input_tokens === 'number') {
      usage.inputTokens = obj.usage.input_tokens;
    }
    if (typeof obj.usage?.output_tokens === 'number') {
      usage.outputTokens = obj.usage.output_tokens;
    }
    return {
      content,
      usage,
      finishReason: mapStopReason(obj.stop_reason),
      model: typeof obj.model === 'string' && obj.model.length > 0 ? obj.model : model,
    };
  }

  protected async *decodeStream(
    response: TransportResponse,
    _input: ChatInput,
    _model: string,
  ): AsyncIterable<StreamEvent> {
    for await (const message of parseSSE(response.lines())) {
      if (message.data === '') {
        continue;
      }
      let event: {
        type?: string;
        delta?: { type?: string; text?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      try {
        event = JSON.parse(message.data);
      } catch {
        // Ignore non-JSON keepalive payloads.
        continue;
      }
      switch (event.type) {
        case 'message_start': {
          const inputTokens = event.message?.usage?.input_tokens;
          if (typeof inputTokens === 'number') {
            yield { content: '', usage: { inputTokens } };
          }
          break;
        }
        case 'content_block_delta': {
          if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
            yield { content: event.delta.text };
          }
          break;
        }
        case 'message_delta': {
          const outputTokens = event.usage?.output_tokens;
          if (typeof outputTokens === 'number') {
            yield { content: '', usage: { outputTokens } };
          }
          break;
        }
        case 'message_stop':
          return;
        default:
          break;
      }
    }
  }
}
