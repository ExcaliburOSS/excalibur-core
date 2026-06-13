import { ProviderError } from '@excalibur/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeResponse, fixture, QueueTransport } from '../__fixtures__/fake-transport';
import type { ChatInput } from '../types';
import { AnthropicAdapter } from './anthropic-provider';
import { CORE_PROVIDER_FACTORIES } from './core-factories';
import { createProvider, PROVIDER_NOT_IMPLEMENTED_CODE } from './create-provider';
import { OllamaAdapter } from './ollama-provider';
import { OpenAICompatibleAdapter } from './openai-compatible-provider';

const chatInput: ChatInput = { messages: [{ role: 'user', content: 'hello' }] };
const KEY_ENV = 'TEST_FACTORY_KEY';

beforeEach(() => {
  process.env[KEY_ENV] = 'sk-test-1234567890abcdefghij';
});
afterEach(() => {
  delete process.env[KEY_ENV];
});

describe('createProvider factory dispatch (OSS-4 gating)', () => {
  it('without deps, real types still resolve to the NotImplementedProvider', async () => {
    const adapter = createProvider('anthropic', { type: 'anthropic' });
    expect(adapter).not.toBeInstanceOf(AnthropicAdapter);
    await expect(adapter.chat(chatInput)).rejects.toMatchObject({
      code: PROVIDER_NOT_IMPLEMENTED_CODE,
    });
  });

  it('with an injected factory map, constructs the real adapter', () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = createProvider(
      'anthropic',
      { type: 'anthropic', apiKeyEnv: KEY_ENV, model: 'm' },
      { transport, factories: CORE_PROVIDER_FACTORIES },
    );
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
  });

  it('maps vllm and custom to the OpenAI-compatible adapter', () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const deps = { transport, factories: CORE_PROVIDER_FACTORIES };
    const vllm = createProvider(
      'vllm',
      { type: 'vllm', baseUrl: 'http://localhost:8000/v1', apiKeyEnv: KEY_ENV, model: 'm' },
      deps,
    );
    const custom = createProvider(
      'custom',
      { type: 'custom', baseUrl: 'http://localhost:9000', apiKeyEnv: KEY_ENV, model: 'm' },
      deps,
    );
    expect(vllm).toBeInstanceOf(OpenAICompatibleAdapter);
    expect(custom).toBeInstanceOf(OpenAICompatibleAdapter);
  });

  it('maps ollama to the OllamaAdapter (no key required)', () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('ollama.chat.json') })]);
    const adapter = createProvider(
      'ollama',
      { type: 'ollama', model: 'm' },
      { transport, factories: CORE_PROVIDER_FACTORIES },
    );
    expect(adapter).toBeInstanceOf(OllamaAdapter);
  });

  it('mock stays the MockProvider even when factories are injected', async () => {
    const transport = new QueueTransport([fakeResponse({ body: '{}' })]);
    const adapter = createProvider(
      'mock',
      { type: 'mock' },
      { transport, factories: CORE_PROVIDER_FACTORIES },
    );
    const output = await adapter.chat(chatInput);
    expect(output.content).toContain('Mock provider (M1)');
  });

  it('a real type absent from the injected map falls back to NotImplemented', () => {
    const transport = new QueueTransport([fakeResponse({ body: '{}' })]);
    // Only anthropic in the map; ollama should stay unimplemented.
    const adapter = createProvider(
      'ollama',
      { type: 'ollama', model: 'm' },
      { transport, factories: { anthropic: CORE_PROVIDER_FACTORIES.anthropic } },
    );
    expect(() => adapter.stream(chatInput)).toThrow(ProviderError);
  });
});
