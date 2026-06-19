/**
 * Ollama adapter (`POST {baseUrl}/api/chat`). No authentication.
 *
 * Wire shape:
 *   body:    { model, messages, stream, options?: { temperature, num_predict } }
 *   response (non-stream): { message: { content }, prompt_eval_count, eval_count,
 *             done_reason }.
 *   stream (newline-delimited JSON): { message: { content } } per chunk,
 *             terminated by a final `{ done: true, prompt_eval_count, eval_count }`.
 */

import { ProviderError } from '@excalibur/shared';
import { parseToolArguments } from '../errors/provider-errors';
import { parseNdjson } from '../transport/sse';
import type { TransportRequest, TransportResponse } from '../transport/transport';
import type { ChatFinishReason, ChatInput, ChatMessage, ChatUsage, ToolCall } from '../types';
import {
  BaseHttpProvider,
  type BaseHttpProviderOptions,
  type ParsedChatResponse,
  type StreamEvent,
} from './base-http-provider';

const DEFAULT_BASE_URL = 'http://localhost:11434';

function mapDoneReason(reason: unknown): ChatFinishReason {
  if (reason === 'length') {
    return 'length';
  }
  // stop, unload, null → stop.
  return 'stop';
}

/**
 * Serializes one normalized message into Ollama's `/api/chat` message form.
 * Tool-calling turns map as:
 *   - assistant with `toolCalls` → `{role:'assistant', content,
 *     tool_calls:[{function:{name, arguments}}]}` (Ollama takes `arguments` as
 *     an object, not a JSON string);
 *   - a `tool` result message → `{role:'tool', content, tool_call_id?}`.
 */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    const wire: Record<string, unknown> = { role: 'tool', content: message.content };
    if (message.toolCallId !== undefined && message.toolCallId.length > 0) {
      wire['tool_call_id'] = message.toolCallId;
    }
    return wire;
  }
  if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: (message.toolCalls ?? []).map((call) => ({
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

export class OllamaAdapter extends BaseHttpProvider {
  private readonly baseUrl: string;

  constructor(options: Omit<BaseHttpProviderOptions, 'requiresApiKey'>) {
    super({ ...options, requiresApiKey: false });
    this.baseUrl = (this.cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private endpoint(): string {
    return `${this.baseUrl}/api/chat`;
  }

  private body(input: ChatInput, model: string, stream: boolean): string {
    const payload: Record<string, unknown> = {
      model,
      messages: input.messages.map(toWireMessage),
      stream,
    };
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
    const options: Record<string, unknown> = {};
    if (input.temperature !== undefined) {
      options['temperature'] = input.temperature;
    }
    if (input.maxTokens !== undefined) {
      options['num_predict'] = input.maxTokens;
    }
    if (Object.keys(options).length > 0) {
      payload['options'] = options;
    }
    return JSON.stringify(payload);
  }

  protected buildChatRequest(input: ChatInput, model: string): TransportRequest {
    return {
      url: this.endpoint(),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.body(input, model, false),
    };
  }

  protected buildStreamRequest(input: ChatInput, model: string): TransportRequest {
    return {
      url: this.endpoint(),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.body(input, model, true),
    };
  }

  protected parseChatResponse(text: string, model: string): ParsedChatResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProviderError('Ollama response was not valid JSON.', {
        code: 'invalid_request',
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
    const obj = parsed as {
      message?: {
        content?: string;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: unknown };
        }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: unknown;
      model?: string;
    };
    const content = typeof obj.message?.content === 'string' ? obj.message.content : '';
    const toolCalls: ToolCall[] = [];
    const rawCalls = obj.message?.tool_calls ?? [];
    rawCalls.forEach((call, index) => {
      const name = typeof call.function?.name === 'string' ? call.function.name : '';
      toolCalls.push({
        // Ollama omits an id; synthesize a stable one from the call's position.
        id: typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${index}`,
        name,
        // Ollama returns `arguments` as an object already; tolerate a string too.
        arguments: parseToolArguments(name, call.function?.arguments),
      });
    });
    const usage: Partial<ChatUsage> = {};
    if (typeof obj.prompt_eval_count === 'number') {
      usage.inputTokens = obj.prompt_eval_count;
    }
    if (typeof obj.eval_count === 'number') {
      usage.outputTokens = obj.eval_count;
    }
    return {
      content,
      usage,
      // A tool-call turn overrides the done_reason → 'tool_calls'; Ollama does
      // not report a distinct done_reason for tool use.
      finishReason: toolCalls.length > 0 ? 'tool_calls' : mapDoneReason(obj.done_reason),
      model: typeof obj.model === 'string' && obj.model.length > 0 ? obj.model : model,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  protected async *decodeStream(
    response: TransportResponse,
    _input: ChatInput,
    _model: string,
  ): AsyncIterable<StreamEvent> {
    for await (const value of parseNdjson(response.lines())) {
      const chunk = value as {
        message?: { content?: string };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const delta = chunk.message?.content;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { content: delta };
      }
      if (chunk.done === true) {
        const usage: Partial<ChatUsage> = {};
        if (typeof chunk.prompt_eval_count === 'number') {
          usage.inputTokens = chunk.prompt_eval_count;
        }
        if (typeof chunk.eval_count === 'number') {
          usage.outputTokens = chunk.eval_count;
        }
        if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
          yield { content: '', usage };
        }
        return;
      }
    }
  }
}
