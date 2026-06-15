/**
 * Tool-calling (function-calling) coverage for the real provider adapters
 * (foundation for the agentic tool loop). Fully offline via the fake transport
 * and fixtures — no network, no keys.
 *
 * Per adapter we assert three things:
 *   1. a tool-call response parses into normalized `ToolCall[]` with the right
 *      name + (JSON-parsed) arguments, and `finishReason === 'tool_calls'`;
 *   2. a follow-up turn carrying an assistant `toolCalls` message and a `tool`
 *      result message serializes to the correct wire body (asserted via the
 *      recorded request);
 *   3. malformed tool arguments surface a typed `ProviderError`, not a crash.
 */

import { ProviderError } from '@excalibur/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deterministicHooks,
  fakeResponse,
  fixture,
  QueueTransport,
} from '../__fixtures__/fake-transport';
import type { ChatInput, ToolSpec } from '../types';
import { AnthropicAdapter } from './anthropic-provider';
import type { BaseProviderHooks } from './base-http-provider';
import { OllamaAdapter } from './ollama-provider';
import { OpenAICompatibleAdapter } from './openai-compatible-provider';
import type { ProviderConfig } from './providers-file';

const ANTHROPIC_KEY_ENV = 'TEST_ANTHROPIC_KEY';
const OPENAI_KEY_ENV = 'TEST_OPENAI_KEY';
const hooks: BaseProviderHooks = deterministicHooks;

const WEATHER_TOOL: ToolSpec = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['city'],
  },
};

/** A request asking for weather, with one tool available. */
const askInput: ChatInput = {
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the weather in Madrid?' },
  ],
  tools: [WEATHER_TOOL],
};

/**
 * A follow-up turn: the assistant requested a tool, we ran it, and now send the
 * tool result back so the model can produce its final answer.
 */
const followUpInput: ChatInput = {
  messages: [
    { role: 'user', content: 'What is the weather in Madrid?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'get_weather', arguments: { city: 'Madrid', unit: 'celsius' } },
      ],
    },
    { role: 'tool', content: '21°C and sunny', toolCallId: 'call_1' },
  ],
  tools: [WEATHER_TOOL],
};

beforeEach(() => {
  process.env[ANTHROPIC_KEY_ENV] = 'sk-ant-api03-EXAMPLEKEY1234567890abcdEXAMPLE';
  process.env[OPENAI_KEY_ENV] = 'sk-proj-EXAMPLEKEY1234567890abcdefEXAMPLE';
});

afterEach(() => {
  delete process.env[ANTHROPIC_KEY_ENV];
  delete process.env[OPENAI_KEY_ENV];
});

function anthropicCfg(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { type: 'anthropic', apiKeyEnv: ANTHROPIC_KEY_ENV, model: 'test-anthropic-model', ...extra };
}
function openaiCfg(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnv: OPENAI_KEY_ENV,
    model: 'test-openai-model',
    ...extra,
  };
}
function ollamaCfg(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { type: 'ollama', model: 'test-ollama-model', ...extra };
}

describe('Anthropic tool calling', () => {
  it('parses tool_use blocks into ToolCall[] with finishReason tool_calls', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('anthropic.tool-use.json') }),
    ]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    const output = await adapter.chat(askInput);
    expect(output.finishReason).toBe('tool_calls');
    expect(output.content).toBe('Let me check the weather.');
    expect(output.toolCalls).toEqual([
      { id: 'toolu_01ABC', name: 'get_weather', arguments: { city: 'Madrid', unit: 'celsius' } },
    ]);
  });

  it('sends tools with input_schema in the request body', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('anthropic.tool-use.json') }),
    ]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    await adapter.chat(askInput);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: WEATHER_TOOL.parameters,
      },
    ]);
  });

  it('serializes a follow-up turn as tool_use + tool_result content blocks', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    await adapter.chat(followUpInput);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.messages).toEqual([
      { role: 'user', content: 'What is the weather in Madrid?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Madrid', unit: 'celsius' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '21°C and sunny' }],
      },
    ]);
  });

  it('coalesces consecutive tool results into ONE user turn (parallel tool use)', async () => {
    // A parallel-tool-use turn: the assistant requested two tools at once, and
    // both results come back as consecutive `tool` messages. They MUST fold into
    // a single `user` turn with two tool_result blocks — emitting two user turns
    // would make Anthropic reject the request ("roles must alternate"). This is
    // also exactly the shape a time-machine fork prefix reconstructs.
    const parallelInput: ChatInput = {
      messages: [
        { role: 'user', content: 'Weather in Madrid and Paris?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'get_weather', arguments: { city: 'Madrid' } },
            { id: 'call_2', name: 'get_weather', arguments: { city: 'Paris' } },
          ],
        },
        { role: 'tool', content: '21°C sunny', toolCallId: 'call_1' },
        { role: 'tool', content: '17°C rain', toolCallId: 'call_2' },
      ],
      tools: [WEATHER_TOOL],
    };
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    await adapter.chat(parallelInput);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}') as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // Three turns total: user → assistant(tool_use ×2) → user(tool_result ×2).
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '21°C sunny' },
        { type: 'tool_result', tool_use_id: 'call_2', content: '17°C rain' },
      ],
    });
    // No two consecutive user turns (the bug this guards against).
    const roles = body.messages.map((m) => m.role);
    expect(roles.some((r, i) => r === 'user' && roles[i + 1] === 'user')).toBe(false);
  });

  it('surfaces a typed error on malformed tool_use input', async () => {
    const body = JSON.stringify({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: '{bad json' }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const transport = new QueueTransport([fakeResponse({ body })]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    await expect(adapter.chat(askInput)).rejects.toMatchObject({
      code: 'invalid_request',
      details: { tool: 'get_weather' },
    });
  });

  it('synthesizes a stable non-empty id when a tool_use block omits one', async () => {
    const body = JSON.stringify({
      content: [
        { type: 'tool_use', name: 'get_weather', input: { city: 'Madrid' } },
        { type: 'tool_use', name: 'get_weather', input: { city: 'Paris' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const transport = new QueueTransport([fakeResponse({ body })]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    const output = await adapter.chat(askInput);
    expect(output.toolCalls?.map((c) => c.id)).toEqual(['call_0', 'call_1']);
    for (const call of output.toolCalls ?? []) {
      expect(call.id.length).toBeGreaterThan(0);
    }
  });
});

describe('OpenAI-compatible tool calling', () => {
  it('parses tool_calls into ToolCall[] with finishReason tool_calls', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('openai.tool-calls.json') }),
    ]);
    const adapter = new OpenAICompatibleAdapter({ name: 'q', cfg: openaiCfg(), transport, hooks });
    const output = await adapter.chat(askInput);
    expect(output.finishReason).toBe('tool_calls');
    expect(output.content).toBe('');
    expect(output.toolCalls).toEqual([
      { id: 'call_01ABC', name: 'get_weather', arguments: { city: 'Madrid', unit: 'celsius' } },
    ]);
  });

  it('sends tools as type:function in the request body', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('openai.tool-calls.json') }),
    ]);
    const adapter = new OpenAICompatibleAdapter({ name: 'q', cfg: openaiCfg(), transport, hooks });
    await adapter.chat(askInput);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: WEATHER_TOOL.parameters,
        },
      },
    ]);
  });

  it('serializes a follow-up turn as message.tool_calls + role:tool result', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({ name: 'q', cfg: openaiCfg(), transport, hooks });
    await adapter.chat(followUpInput);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.messages).toEqual([
      { role: 'user', content: 'What is the weather in Madrid?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Madrid","unit":"celsius"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '21°C and sunny' },
    ]);
  });

  it('surfaces a typed error on malformed JSON arguments', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('openai.tool-calls.malformed.json') }),
    ]);
    const adapter = new OpenAICompatibleAdapter({ name: 'q', cfg: openaiCfg(), transport, hooks });
    let caught: unknown;
    try {
      await adapter.chat(askInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ code: 'invalid_request', details: { tool: 'get_weather' } });
  });

  it('synthesizes a stable non-empty id when a tool_call omits one', async () => {
    const body = JSON.stringify({
      model: 'test-openai-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { type: 'function', function: { name: 'get_weather', arguments: '{"city":"Madrid"}' } },
              { type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    });
    const transport = new QueueTransport([fakeResponse({ body })]);
    const adapter = new OpenAICompatibleAdapter({ name: 'q', cfg: openaiCfg(), transport, hooks });
    const output = await adapter.chat(askInput);
    expect(output.toolCalls?.map((c) => c.id)).toEqual(['call_0', 'call_1']);
    for (const call of output.toolCalls ?? []) {
      expect(call.id.length).toBeGreaterThan(0);
    }
  });
});

describe('Ollama tool calling', () => {
  it('parses tool_calls (object args) into ToolCall[] with synthesized id', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('ollama.tool-calls.json') }),
    ]);
    const adapter = new OllamaAdapter({ name: 'o', cfg: ollamaCfg(), transport, hooks });
    const output = await adapter.chat(askInput);
    expect(output.finishReason).toBe('tool_calls');
    expect(output.toolCalls).toEqual([
      { id: 'call_0', name: 'get_weather', arguments: { city: 'Madrid', unit: 'celsius' } },
    ]);
  });

  it('sends tools as type:function in the request body', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('ollama.tool-calls.json') }),
    ]);
    const adapter = new OllamaAdapter({ name: 'o', cfg: ollamaCfg(), transport, hooks });
    await adapter.chat(askInput);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: WEATHER_TOOL.parameters,
        },
      },
    ]);
  });

  it('serializes a follow-up turn as tool_calls (object args) + role:tool result', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('ollama.chat.json') })]);
    const adapter = new OllamaAdapter({ name: 'o', cfg: ollamaCfg(), transport, hooks });
    await adapter.chat(followUpInput);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.messages).toEqual([
      { role: 'user', content: 'What is the weather in Madrid?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'get_weather', arguments: { city: 'Madrid', unit: 'celsius' } } },
        ],
      },
      { role: 'tool', content: '21°C and sunny', tool_call_id: 'call_1' },
    ]);
  });

  it('surfaces a typed error on malformed string arguments', async () => {
    const body = JSON.stringify({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: '{bad json' } }],
      },
      done: true,
    });
    const transport = new QueueTransport([fakeResponse({ body })]);
    const adapter = new OllamaAdapter({ name: 'o', cfg: ollamaCfg(), transport, hooks });
    await expect(adapter.chat(askInput)).rejects.toMatchObject({
      code: 'invalid_request',
      details: { tool: 'get_weather' },
    });
  });

  it('synthesizes a stable non-empty id when a tool_call omits one', async () => {
    const body = JSON.stringify({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'get_weather', arguments: { city: 'Madrid' } } },
          { function: { name: 'get_weather', arguments: { city: 'Paris' } } },
        ],
      },
      done: true,
    });
    const transport = new QueueTransport([fakeResponse({ body })]);
    const adapter = new OllamaAdapter({ name: 'o', cfg: ollamaCfg(), transport, hooks });
    const output = await adapter.chat(askInput);
    expect(output.toolCalls?.map((c) => c.id)).toEqual(['call_0', 'call_1']);
    for (const call of output.toolCalls ?? []) {
      expect(call.id.length).toBeGreaterThan(0);
    }
  });
});

describe('text-only requests are unaffected (additive)', () => {
  it('omits tools and toolCalls when none are provided', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    const output = await adapter.chat({
      messages: [{ role: 'user', content: 'Say hello.' }],
    });
    expect(output.toolCalls).toBeUndefined();
    expect(output.finishReason).toBe('stop');
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.tools).toBeUndefined();
  });
});
