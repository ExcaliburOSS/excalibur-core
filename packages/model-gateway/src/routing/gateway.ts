import { ProviderError } from '@excalibur/shared';
import { computeCostCents, estimateTokens } from '../cost/cost';
import { createProvider, type CreateProviderDeps } from '../providers/create-provider';
import type { ProviderConfig, ProvidersFileConfig } from '../providers/providers-file';
import type {
  ChatDelta,
  ChatInput,
  ChatOutput,
  ChatUsage,
  ModelProviderAdapter,
} from '../types';

/**
 * Model gateway (Build Contract §4.3): resolves the provider by explicit name
 * or configured default, delegates chat/stream to the adapter and computes
 * `costCents` from the provider's cost metadata via `computeCostCents`.
 *
 * An optional second constructor argument injects real provider adapters
 * (OSS-4, M2). Without it, `new ModelGateway(cfg)` behaves exactly as in M1
 * (mock executes; real types throw `provider_not_implemented`).
 */

export type GatewayChatInput = ChatInput & { provider?: string };

/** Optional dependencies enabling real provider adapters (OSS-4, M2). */
export type ModelGatewayDeps = CreateProviderDeps;

export class ModelGateway {
  private readonly config: ProvidersFileConfig;
  private readonly deps: ModelGatewayDeps | undefined;
  private readonly adapters = new Map<string, ModelProviderAdapter>();

  constructor(cfg: ProvidersFileConfig, deps?: ModelGatewayDeps) {
    this.config = cfg;
    this.deps = deps;
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
    const adapter = createProvider(name, cfg, this.deps);
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

  /**
   * Streams deltas and RETURNS the assembled `ChatOutput` (M2, Slice 2).
   *
   * Yields each `ChatDelta` from the resolved provider, then returns the final
   * output with `costCents` computed via the exact same path as {@link chat}.
   * The public delta stream carries no usage, so usage is estimated from the
   * concatenated content + the input messages using `estimateTokens` — the
   * same estimation `MockProvider.chat()` uses, so the mock's streamed and
   * non-streamed outputs report identical usage and cost.
   *
   * The existing {@link stream} is left untouched for callers that only need
   * deltas.
   */
  async *streamWithUsage(input: GatewayChatInput): AsyncGenerator<ChatDelta, ChatOutput> {
    const { cfg, adapter, chatInput } = this.prepare(input);
    const chunks: string[] = [];
    for await (const delta of adapter.stream(chatInput)) {
      if (delta.content.length > 0) {
        chunks.push(delta.content);
      }
      yield delta;
    }

    const content = chunks.join('');
    const usage: ChatUsage = {
      inputTokens: estimateTokens(chatInput.messages.map((message) => message.content).join('\n')),
      outputTokens: estimateTokens(content),
    };
    const computed = computeCostCents(usage, cfg);
    return {
      content,
      model: chatInput.model ?? cfg.model ?? 'unknown',
      usage,
      costCents: computed,
      finishReason: 'stop',
    };
  }
}
