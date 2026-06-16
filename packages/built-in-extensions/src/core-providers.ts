import type { Contribution, ExtensionManifest } from '@excalibur/extension-runtime';
import {
  CORE_PROVIDER_FACTORIES,
  type ProviderFactory,
  type ProviderFactoryMap,
} from '@excalibur/model-gateway';
import { BUILT_IN_EXTENSION_VERSION, type BuiltInExtensionPack } from './types';

/**
 * `core-providers` — the real model provider adapters (EXT-6) packaged as
 * built-in `model_provider` extension contributions, so providers are
 * first-class, listable (`excalibur extensions`) and governable through the
 * extension system rather than hardcoded. The factory implementations stay in
 * `@excalibur/model-gateway` (single source of truth); this pack wraps each one
 * as a contribution whose runtime `value` IS the factory, and
 * {@link coreProviderFactories} re-assembles the gateway's factory map FROM
 * those contributions — the gateway sources its providers from the EXT-6
 * representation. Unlike the declarative packs, these contributions are
 * programmatic (a `value`, not a parsed `definition`).
 */

const EXTENSION_ID = 'core-providers';

/** Built-in provider types, in a stable order (the keys of the factory map). */
const PROVIDER_TYPES = Object.keys(CORE_PROVIDER_FACTORIES) as Array<keyof ProviderFactoryMap>;

const manifest: ExtensionManifest = {
  id: EXTENSION_ID,
  name: 'Core Model Providers',
  version: BUILT_IN_EXTENSION_VERSION,
  kind: 'declarative',
  description:
    'Built-in model provider adapters (openai-compatible, anthropic, ollama, vllm, custom) as EXT-6 model_provider contributions.',
  contributes: {
    modelProviders: PROVIDER_TYPES.map(String),
  },
};

/** `core-providers` — each real provider adapter as a `model_provider` contribution. */
export const CORE_PROVIDERS_PACK: BuiltInExtensionPack = {
  manifest,
  contributions: PROVIDER_TYPES.map(
    (type): Contribution => ({
      kind: 'model_provider',
      id: String(type),
      extensionId: EXTENSION_ID,
      source: 'built_in',
      value: CORE_PROVIDER_FACTORIES[type],
    }),
  ),
};

/**
 * The provider-factory map assembled FROM the `core-providers` pack's
 * `model_provider` contributions — the EXT-6 representation the gateway sources
 * from. Synchronous (the pack is a static const), so it carries no async /
 * registry-scan cost at gateway construction.
 */
export function coreProviderFactories(): ProviderFactoryMap {
  const map: ProviderFactoryMap = {};
  for (const contribution of CORE_PROVIDERS_PACK.contributions) {
    if (contribution.kind === 'model_provider' && typeof contribution.value === 'function') {
      map[contribution.id as keyof ProviderFactoryMap] = contribution.value as ProviderFactory;
    }
  }
  return map;
}
