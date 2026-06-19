/**
 * The default Core provider-factory map (OSS-4, M2).
 *
 * Real adapters are constructed ONLY when this map (or a custom one) is
 * explicitly injected into `createProvider` / `ModelGateway`. Without it, the
 * gateway preserves M1 behavior (mock → MockProvider; real types →
 * NotImplementedProvider). This file holds the map in isolation so
 * `create-provider.ts` can import only the TYPES and avoid an import cycle.
 *
 * The CLI wires `CORE_PROVIDER_FACTORIES` at gateway-context construction, so a
 * configured `providers.yaml` gets real providers; tests inject the same map
 * with a fake transport to run end-to-end offline.
 */

import type { HttpTransport } from '../transport/transport';
import type { ModelProviderAdapter } from '../types';
import { AnthropicAdapter } from './anthropic-provider';
import { OllamaAdapter } from './ollama-provider';
import { OpenAICompatibleAdapter } from './openai-compatible-provider';
import type { ProviderConfig, ProviderType } from './providers-file';

/**
 * Builds a real adapter from a provider entry, given an injected transport and
 * an optional pre-resolved `apiKey`. When `apiKey` is omitted the adapter falls
 * back to env-var resolution (`cfg.apiKeyEnv`), so OSS callers are unaffected.
 */
export type ProviderFactory = (
  name: string,
  cfg: ProviderConfig,
  deps: { transport: HttpTransport; apiKey?: string },
) => ModelProviderAdapter;

/** A partial map from provider type to its factory. */
export type ProviderFactoryMap = Partial<Record<ProviderType, ProviderFactory>>;

/**
 * Maps each real provider type to its adapter. `vllm` and `custom` both speak
 * the OpenAI-compatible wire format. `mock` is intentionally absent — the mock
 * provider is constructed directly in `createProvider`, never via a factory.
 */
export const CORE_PROVIDER_FACTORIES: ProviderFactoryMap = {
  anthropic: (name, cfg, deps) =>
    new AnthropicAdapter(withApiKey({ name, cfg, transport: deps.transport }, deps.apiKey)),
  'openai-compatible': (name, cfg, deps) =>
    new OpenAICompatibleAdapter(withApiKey({ name, cfg, transport: deps.transport }, deps.apiKey)),
  vllm: (name, cfg, deps) =>
    new OpenAICompatibleAdapter(withApiKey({ name, cfg, transport: deps.transport }, deps.apiKey)),
  custom: (name, cfg, deps) =>
    new OpenAICompatibleAdapter(withApiKey({ name, cfg, transport: deps.transport }, deps.apiKey)),
  ollama: (name, cfg, deps) =>
    new OllamaAdapter(withApiKey({ name, cfg, transport: deps.transport }, deps.apiKey)),
};

/**
 * Attaches an injected `apiKey` to the adapter options only when one is present.
 * Keeping the property absent (rather than `undefined`) preserves the exact
 * env-resolution path for OSS callers that pass no key.
 */
function withApiKey<T extends { transport: HttpTransport }>(
  options: T,
  apiKey: string | undefined,
): T & { apiKey?: string } {
  return apiKey !== undefined && apiKey.length > 0 ? { ...options, apiKey } : options;
}
