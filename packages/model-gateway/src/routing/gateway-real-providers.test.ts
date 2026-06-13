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
    expect(transport.requests[0]?.request.headers?.['authorization']).toBe(
      `Bearer ${injectedKey}`,
    );
  });

  it('without injected deps, a real provider still throws provider_not_implemented', async () => {
    const gateway = new ModelGateway(
      config({ default: 'qwen', qwen: { type: 'openai-compatible', baseUrl: 'https://x/v1' } }),
    );
    await expect(gateway.chat({ messages })).rejects.toMatchObject({
      code: 'provider_not_implemented',
    });
  });
});
