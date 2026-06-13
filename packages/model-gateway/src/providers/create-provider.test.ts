import { ProviderError } from '@excalibur/shared';
import { describe, expect, it } from 'vitest';
import type { ChatInput } from '../types';
import { createProvider, PROVIDER_NOT_IMPLEMENTED_CODE } from './create-provider';
import { MockProvider } from './mock-provider';
import type { ProviderType } from './providers-file';

const chatInput: ChatInput = {
  messages: [{ role: 'user', content: 'hello' }],
};

const REAL_PROVIDER_TYPES: ProviderType[] = [
  'openai-compatible',
  'anthropic',
  'ollama',
  'vllm',
  'custom',
];

describe('createProvider', () => {
  it('returns a MockProvider for the mock type, keeping the configured name', async () => {
    const adapter = createProvider('local-mock', { type: 'mock', model: 'excalibur-mock' });
    expect(adapter).toBeInstanceOf(MockProvider);
    expect(adapter.name).toBe('local-mock');
    expect((await adapter.chat(chatInput)).model).toBe('excalibur-mock');
  });

  it.each(REAL_PROVIDER_TYPES)(
    '%s adapters reject chat with provider_not_implemented mentioning OSS-4 (M2)',
    async (type) => {
      const adapter = createProvider('some-provider', { type });
      const promise = adapter.chat(chatInput);
      await expect(promise).rejects.toBeInstanceOf(ProviderError);
      await expect(promise).rejects.toMatchObject({
        code: PROVIDER_NOT_IMPLEMENTED_CODE,
      });
      await expect(promise).rejects.toThrowError(/real providers arrive in OSS-4 \(M2\)/);
    },
  );

  it.each(REAL_PROVIDER_TYPES)('%s adapters throw on stream too', (type) => {
    const adapter = createProvider('some-provider', { type });
    try {
      adapter.stream(chatInput);
      expect.unreachable('stream() must throw for unimplemented providers');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      if (error instanceof ProviderError) {
        expect(error.code).toBe('provider_not_implemented');
        expect(error.message).toContain('OSS-4 (M2)');
        expect(error.details).toMatchObject({ provider: 'some-provider', type });
      }
    }
  });

  it('exposes the adapter name on unimplemented providers', () => {
    const adapter = createProvider('qwen', { type: 'openai-compatible' });
    expect(adapter.name).toBe('qwen');
  });
});
