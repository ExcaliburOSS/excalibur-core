import { ProviderError } from '@excalibur/shared';
import type { ChatDelta, ChatInput, ChatOutput, ModelProviderAdapter } from '../types';
import { MockProvider } from './mock-provider';
import type { ProviderConfig } from './providers-file';

/**
 * Provider factory (Build Contract §4.3). In M1 only the `mock` type is
 * executable; real provider types resolve to an adapter whose methods throw
 * `ProviderError` (code `provider_not_implemented`) until OSS-4 lands in M2.
 */

export const PROVIDER_NOT_IMPLEMENTED_CODE = 'provider_not_implemented';

class NotImplementedProvider implements ModelProviderAdapter {
  readonly name: string;
  private readonly type: ProviderConfig['type'];

  constructor(name: string, type: ProviderConfig['type']) {
    this.name = name;
    this.type = type;
  }

  private fail(): never {
    throw new ProviderError(
      `Provider "${this.name}" (type "${this.type}") cannot execute yet: real providers arrive in OSS-4 (M2). Use the built-in "mock" provider in M1.`,
      {
        code: PROVIDER_NOT_IMPLEMENTED_CODE,
        details: { provider: this.name, type: this.type },
      },
    );
  }

  async chat(_input: ChatInput): Promise<ChatOutput> {
    return this.fail();
  }

  stream(_input: ChatInput): AsyncIterable<ChatDelta> {
    return this.fail();
  }
}

/** Creates the adapter for a configured provider entry. */
export function createProvider(name: string, cfg: ProviderConfig): ModelProviderAdapter {
  if (cfg.type === 'mock') {
    const options: { name: string; model?: string } = { name };
    if (cfg.model !== undefined) {
      options.model = cfg.model;
    }
    return new MockProvider(options);
  }
  return new NotImplementedProvider(name, cfg.type);
}
