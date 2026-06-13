import { ProviderError } from '@excalibur/shared';
import { computeCostCents } from '../cost/cost';
import { createProvider } from '../providers/create-provider';
import type { ProviderConfig, ProvidersFileConfig } from '../providers/providers-file';
import type { ChatDelta, ChatInput, ChatOutput, ModelProviderAdapter } from '../types';

/**
 * Model gateway (Build Contract §4.3): resolves the provider by explicit name
 * or configured default, delegates chat/stream to the adapter and computes
 * `costCents` from the provider's cost metadata via `computeCostCents`.
 */

export type GatewayChatInput = ChatInput & { provider?: string };

export class ModelGateway {
  private readonly config: ProvidersFileConfig;
  private readonly adapters = new Map<string, ModelProviderAdapter>();

  constructor(cfg: ProvidersFileConfig) {
    this.config = cfg;
  }

  /** Named provider entries (the `default` pointer is not a provider). */
  private providerNames(): string[] {
    return Object.keys(this.config.providers).filter((key) => key !== 'default');
  }

  private resolveProviderName(explicit?: string): string {
    const names = this.providerNames();

    if (explicit !== undefined && explicit.length > 0) {
      if (explicit === 'default' || !names.includes(explicit)) {
        throw new ProviderError(
          `Unknown model provider "${explicit}". Configured providers: ${names.join(', ') || '(none)'}.`,
          { code: 'provider_not_found', details: { provider: explicit, configured: names } },
        );
      }
      return explicit;
    }

    const section: { default?: string } = this.config.providers;
    if (section.default !== undefined) {
      if (!names.includes(section.default)) {
        throw new ProviderError(
          `Default provider "${section.default}" is not configured. Configured providers: ${names.join(', ') || '(none)'}.`,
          { code: 'provider_not_found', details: { provider: section.default, configured: names } },
        );
      }
      return section.default;
    }

    const [only] = names;
    if (names.length === 1 && only !== undefined) {
      return only;
    }

    throw new ProviderError(
      'No model provider specified and no default configured in providers.yaml.',
      { code: 'provider_not_found', details: { configured: names } },
    );
  }

  private providerConfig(name: string): ProviderConfig {
    const section: Record<string, ProviderConfig> = this.config.providers;
    const cfg = section[name];
    if (cfg === undefined) {
      throw new ProviderError(`Model provider "${name}" is not configured.`, {
        code: 'provider_not_found',
        details: { provider: name },
      });
    }
    return cfg;
  }

  private adapterFor(name: string, cfg: ProviderConfig): ModelProviderAdapter {
    const cached = this.adapters.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const adapter = createProvider(name, cfg);
    this.adapters.set(name, adapter);
    return adapter;
  }

  private prepare(input: GatewayChatInput): {
    cfg: ProviderConfig;
    adapter: ModelProviderAdapter;
    chatInput: ChatInput;
  } {
    const { provider, ...rest } = input;
    const name = this.resolveProviderName(provider);
    const cfg = this.providerConfig(name);
    const adapter = this.adapterFor(name, cfg);
    const chatInput: ChatInput = { ...rest, model: rest.model ?? cfg.model };
    return { cfg, adapter, chatInput };
  }

  async chat(input: GatewayChatInput): Promise<ChatOutput> {
    const { cfg, adapter, chatInput } = this.prepare(input);
    const output = await adapter.chat(chatInput);
    const computed = computeCostCents(output.usage, cfg);
    return { ...output, costCents: computed ?? output.costCents };
  }

  async *stream(input: GatewayChatInput): AsyncIterable<ChatDelta> {
    const { adapter, chatInput } = this.prepare(input);
    yield* adapter.stream(chatInput);
  }
}
