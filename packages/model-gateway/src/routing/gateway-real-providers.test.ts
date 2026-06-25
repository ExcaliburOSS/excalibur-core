import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeResponse, fixture, QueueTransport } from '../__fixtures__/fake-transport';
import { CORE_PROVIDER_FACTORIES } from '../providers/core-factories';
import type { ProvidersFileConfig, ProvidersSection } from '../providers/providers-file';
import type { ChatDelta, ChatMessage } from '../types';
import { ModelGateway } from './gateway';

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are Excalibur.' },
  { role: 'user', content: 'Explain the release flow.' },
];

const KEY_ENV = 'TEST_GATEWAY_OPENAI_KEY';

function config(providers: Record<string, unknown>): ProvidersFileConfig {
  return { providers: providers as ProvidersSection };
}

async function collectStream(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const delta of iterable) {
    out.push(delta);
  }
  return out;
}

beforeEach(() => {
  process.env[KEY_ENV] = 'sk-proj-EXAMPLEKEY1234567890abcdefEXAMPLE';
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

describe('ModelGateway with injected real providers (offline)', () => {
  it('runs a real chat() end-to-end and overlays cost from provider config', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const gateway = new ModelGateway(
      config({
        default: 'qwen',
        qwen: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: KEY_ENV,
          model: 'test-openai-model',
          inputCostPerMillionTokensCents: 300,
          outputCostPerMillionTokensCents: 1500,
        },
      }),
      { transport, factories: CORE_PROVIDER_FACTORIES },
    );
    const output = await gateway.chat({ messages });
    expect(output.content).toBe('Hello from the OpenAI-compatible model.');
    expect(output.usage).toEqual({ inputTokens: 31, outputTokens: 9 });
    // Gateway computes cents from usage * rates (31*300 + 9*1500) / 1e6.
    expect(output.costCents).not.toBeNull();
    expect(output.costCents ?? 0).toBeGreaterThan(0);
  });

  it('runs a real stream() end-to-end with the concat invariant', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('openai.stream.sse.txt') }),
    ]);
    const gateway = new ModelGateway(
      config({
        default: 'qwen',
        qwen: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: KEY_ENV,
          model: 'test-openai-model',
        },
      }),
      { transport, factories: CORE_PROVIDER_FACTORIES },
    );
    const deltas = await collectStream(gateway.stream({ messages }));
    expect(deltas[deltas.length - 1]).toEqual({ content: '', done: true });
    expect(deltas.map((delta) => delta.content).join('')).toBe(
      'Hello from the OpenAI-compatible model.',
    );
  });

  it('streamWithUsage reports the provider usage chunk, not an estimate', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('openai.stream.sse.txt') }),
    ]);
    const gateway = new ModelGateway(
      config({
        default: 'qwen',
        qwen: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: KEY_ENV,
          model: 'test-openai-model',
          inputCostPerMillionTokensCents: 300,
          outputCostPerMillionTokensCents: 1500,
        },
      }),
      { transport, factories: CORE_PROVIDER_FACTORIES },
    );
    const gen = gateway.streamWithUsage({ messages });
    let next = await gen.next();
    while (!next.done) {
      next = await gen.next();
    }
    const output = next.value;
    // Exact provider-reported numbers from the SSE usage chunk — NOT estimated.
    expect(output.usage).toEqual({ inputTokens: 31, outputTokens: 9 });
    // Cost is therefore computed from the real numbers: (31*300 + 9*1500)/1e6.
    expect(output.costCents).toBeCloseTo((31 * 300 + 9 * 1500) / 1e6, 10);
  });

  it('threads an injected keyResolver through to the real adapter', async () => {
    const injectedKey = 'sk-proj-GATEWAYINJECTED1234567890abcdef';
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const gateway = new ModelGateway(
      config({
        default: 'qwen',
        qwen: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.test/v1',
          model: 'test-openai-model',
        },
      }),
      {
        transport,
        factories: CORE_PROVIDER_FACTORIES,
        keyResolver: (name) => (name === 'qwen' ? injectedKey : null),
      },
    );
    await gateway.chat({ messages });
    expect(transport.requests[0]?.request.headers?.['authorization']).toBe(`Bearer ${injectedKey}`);
  });

  it('without injected deps, a real provider still throws provider_not_implemented', async () => {
    const gateway = new ModelGateway(
      config({ default: 'qwen', qwen: { type: 'openai-compatible', baseUrl: 'https://x/v1' } }),
    );
    await expect(gateway.chat({ messages })).rejects.toMatchObject({
      code: 'provider_not_implemented',
    });
  });

  it('streamChat streams content AND assembles a streamed tool call (openai-compatible)', async () => {
    // A turn that narrates, then calls a tool — the `arguments` JSON arrives in
    // two fragments across chunks (the real OpenAI streaming shape).
    const sse = [
      'data: {"choices":[{"delta":{"content":"Let me read "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"the file."}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"read_file","arguments":"{\\"path\\":\\"sr"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"c/a.ts\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const transport = new QueueTransport([fakeResponse({ body: sse })]);
    const gateway = new ModelGateway(
      config({
        default: 'qwen',
        qwen: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: KEY_ENV,
          model: 'test-openai-model',
        },
      }),
      { transport, factories: CORE_PROVIDER_FACTORIES },
    );
    const chunks: string[] = [];
    const output = await gateway.streamChat({ messages }, (delta) => chunks.push(delta));
    // The prose streamed live, chunk by chunk.
    expect(chunks).toEqual(['Let me read ', 'the file.']);
    expect(output.content).toBe('Let me read the file.');
    // The streamed tool call assembled into a complete, parsed ToolCall.
    expect(output.finishReason).toBe('tool_calls');
    expect(output.toolCalls).toEqual([
      { id: 'call_x', name: 'read_file', arguments: { path: 'src/a.ts' } },
    ]);
  });

  it('streamChat falls back to a single chat() for a provider that cannot stream tool calls', async () => {
    // The mock is not openai-compatible → no streamed tool-call deltas, so the
    // gateway must NOT risk losing a tool call: it runs one chat() instead.
    const gateway = new ModelGateway(config({ default: 'mock', mock: { type: 'mock' } }));
    const chunks: string[] = [];
    const output = await gateway.streamChat({ messages }, (delta) => chunks.push(delta));
    expect(chunks).toEqual([]); // no streaming on the fallback path
    expect(output.content.length).toBeGreaterThan(0);
    // Identical to a plain chat() on the same input.
    const direct = await gateway.chat({ messages });
    expect(output.content).toBe(direct.content);
  });
});
