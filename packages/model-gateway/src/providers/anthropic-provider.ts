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

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

function mapStopReason(stopReason: unknown): ChatFinishReason {
  if (stopReason === 'max_tokens') {
    return 'length';
  }
  if (stopReason === 'tool_use') {
    return 'tool_calls';
  }
  // end_turn, stop_sequence, null → stop.
  return 'stop';
}

/** A single Anthropic message turn (content is text or a content-block array). */
interface AnthropicTurn {
  role: 'user' | 'assistant';
  content: string | Array<Record<string, unknown>>;
}

/**
 * Builds the Anthropic content-block array for an assistant turn that requested
 * tools: an optional leading `text` block then one `tool_use` block per call
 * (`id`, `name`, `input`).
 */
function assistantToolUseContent(message: ChatMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (message.content.length > 0) {
    blocks.push({ type: 'text', text: message.content });
  }
  for (const call of message.toolCalls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.arguments,
    });
  }
  return blocks;
}

/**
 * Splits messages into the top-level `system` string and user/assistant turns.
 * Tool-calling messages serialize into Anthropic's content-block form:
 *   - an assistant message with `toolCalls` → `tool_use` blocks;
 *   - one or MORE consecutive `tool` result messages → a SINGLE `user` turn
 *     carrying all of their `tool_result` blocks.
 *
 * Coalescing consecutive tool results is REQUIRED: a parallel-tool-use turn (the
 * model requests N tools at once) emits N `tool` messages in a row, as does a
 * reconstructed time-machine fork prefix. Emitting one `user` turn per result
 * would produce consecutive `user` turns, which Anthropic rejects ("roles must
 * alternate"). The OpenAI format keeps one message per tool result, so this
 * fix lives only in the Anthropic mapping.
 */
function splitSystem(messages: ChatMessage[]): {
  system: string | undefined;
  turns: AnthropicTurn[];
} {
  const systemParts: string[] = [];
  const turns: AnthropicTurn[] = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      turns.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      });
      continue;
    }
    // Any non-tool message ends a run of consecutive tool results.
    flushToolResults();
    if (message.role === 'system') {
      systemParts.push(message.content);
    } else if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      turns.push({ role: 'assistant', content: assistantToolUseContent(message) });
    } else {
      turns.push({ role: message.role, content: message.content });
    }
  }
  flushToolResults();

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
    if (input.tools !== undefined && input.tools.length > 0) {
      payload['tools'] = input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
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
      content?: Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: unknown;
      model?: string;
    };
    const blocks = obj.content ?? [];
    const content = blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('');
    const toolCalls: ToolCall[] = [];
    let toolIndex = 0;
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name : '';
        toolCalls.push({
          // Anthropic normally sends an id; synthesize a stable one from the
          // call's position when it is missing/empty so the result round-trip
          // never carries an empty tool_use_id.
          id: typeof block.id === 'string' && block.id.length > 0 ? block.id : `call_${toolIndex}`,
          name,
          // Anthropic returns `input` as an already-parsed object; tolerate a
          // string form too. Malformed args surface a typed error.
          arguments: parseToolArguments(name, block.input),
        });
        toolIndex += 1;
      }
    }
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
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
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
