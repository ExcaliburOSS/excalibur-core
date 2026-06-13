import { ProviderError } from '@excalibur/shared';
import { createFetchTransport } from '../transport/fetch-transport';
import type { HttpTransport } from '../transport/transport';
import type { ChatDelta, ChatInput, ChatOutput, ModelProviderAdapter } from '../types';
import type { ProviderFactoryMap } from './core-factories';
import { MockProvider } from './mock-provider';
import type { ProviderConfig } from './providers-file';

/**
 * Provider factory (Build Contract §4.3).
 *
 * `mock` is always executable. Real provider types resolve to an adapter whose
 * methods throw `ProviderError` (`provider_not_implemented`) UNLESS a
 * provider-factory map is explicitly injected via `deps.factories` — the OSS-4
 * (M2) opt-in. This preserves M1 behavior for every existing caller that
 * constructs providers without deps (the 980 Core tests depend on it).
 */

export const PROVIDER_NOT_IMPLEMENTED_CODE = 'provider_not_implemented';

/** Optional dependencies enabling real provider adapters (OSS-4, M2). */
export interface CreateProviderDeps {
  /** HTTP transport injected into real adapters (defaults to a fetch transport). */
  transport?: HttpTransport;
  /** Map of provider type → factory; when absent, real types stay unimplemented. */
  factories?: ProviderFactoryMap;
}

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

/**
 * Creates the adapter for a configured provider entry.
 *
 * - `mock` → `MockProvider` (zero-config default; unchanged from M1).
 * - real type with `deps.factories[type]` present → that factory's adapter,
 *   constructed with a transport (`deps.transport` or a default fetch transport).
 * - real type without an injected factory → `NotImplementedProvider`
 *   (identical message/code to M1).
 *
 * `deps` is optional and defaults to undefined, so every existing caller that
 * calls `createProvider(name, cfg)` keeps the exact M1 behavior.
 */
export function createProvider(
  name: string,
  cfg: ProviderConfig,
  deps?: CreateProviderDeps,
): ModelProviderAdapter {
  if (cfg.type === 'mock') {
    const options: { name: string; model?: string } = { name };
    if (cfg.model !== undefined) {
      options.model = cfg.model;
    }
    return new MockProvider(options);
  }

  const factory = deps?.factories?.[cfg.type];
  if (factory !== undefined) {
    const transport = deps?.transport ?? defaultTransport();
    return factory(name, cfg, { transport });
  }

  return new NotImplementedProvider(name, cfg.type);
}

let cachedDefaultTransport: HttpTransport | null = null;

/** Builds (and memoizes) the fetch-backed transport for real adapters. */
function defaultTransport(): HttpTransport {
  if (cachedDefaultTransport === null) {
    cachedDefaultTransport = createFetchTransport();
  }
  return cachedDefaultTransport;
}
