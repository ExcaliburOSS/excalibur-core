import { ProviderError } from '@excalibur/shared';
import { computeCostCents, estimateTokens } from '../cost/cost';
import { createProvider, type CreateProviderDeps } from '../providers/create-provider';
import { RESERVED_PROVIDER_KEYS } from '../providers/providers-file';
import type { ProviderConfig, ProvidersFileConfig } from '../providers/providers-file';
import type { ChatDelta, ChatInput, ChatOutput, ChatUsage, ModelProviderAdapter } from '../types';

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

/**
 * Optional dependencies enabling real provider adapters (OSS-4, M2). Besides
 * the transport + factory map, an optional `keyResolver` supplies a pre-decrypted
 * API key per provider (for hosts that keep keys outside `process.env`); it is
 * threaded straight through to {@link createProvider}. Without deps — or without
 * a `keyResolver` — behavior is byte-identical to env-based resolution.
 */
export type ModelGatewayDeps = CreateProviderDeps;

export class ModelGateway {
  private readonly config: ProvidersFileConfig;
  private readonly deps: ModelGatewayDeps | undefined;
  private readonly adapters = new Map<string, ModelProviderAdapter>();

  constructor(cfg: ProvidersFileConfig, deps?: ModelGatewayDeps) {
    this.config = cfg;
    this.deps = deps;
  }

  /** Named provider entries (the `default`/`cheap` role pointers are not providers). */
  private providerNames(): string[] {
    return Object.keys(this.config.providers).filter(
      (key) => !RESERVED_PROVIDER_KEYS.includes(key),
    );
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

  /**
   * The configured context window (tokens) for a provider (or the resolved
   * default), or undefined when unset/unresolvable. Read-only — for callers
   * (e.g. compaction) that need to size the window without touching internals.
   */
  contextWindow(provider?: string): number | undefined {
    try {
      return this.providerConfig(this.resolveProviderName(provider)).contextWindow;
    } catch {
      return undefined;
    }
  }

  /** The `cheap` role's provider name, when configured (the fast pairing model). */
  cheapProviderName(): string | undefined {
    const section = this.config.providers as { cheap?: string };
    return typeof section.cheap === 'string' && section.cheap.length > 0
      ? section.cheap
      : undefined;
  }

  /**
   * The configured `type` of a provider (or the resolved default), or undefined
   * when unset/unresolvable. Read-only — lets callers (e.g. compaction) detect the
   * `mock` test double and skip model-backed work that would yield nonsense.
   */
  providerType(provider?: string): string | undefined {
    try {
      return this.providerConfig(this.resolveProviderName(provider)).type;
    } catch {
      return undefined;
    }
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
   * Provider-reported usage carried on the deltas is PREFERRED per-field; any
   * field the provider omits (e.g. the mock, which reports none) falls back to
   * estimating from the concatenated content + input messages via
   * `estimateTokens` — so the mock's streamed and non-streamed outputs still
   * report identical usage and cost.
   *
   * The existing {@link stream} is left untouched for callers that only need
   * deltas.
   */
  async *streamWithUsage(input: GatewayChatInput): AsyncGenerator<ChatDelta, ChatOutput> {
    const { cfg, adapter, chatInput } = this.prepare(input);
    const chunks: string[] = [];
    const reported: Partial<ChatUsage> = {};
    for await (const delta of adapter.stream(chatInput)) {
      if (delta.content.length > 0) {
        chunks.push(delta.content);
      }
      if (delta.usage?.inputTokens !== undefined) {
        reported.inputTokens = delta.usage.inputTokens;
      }
      if (delta.usage?.outputTokens !== undefined) {
        reported.outputTokens = delta.usage.outputTokens;
      }
      yield delta;
    }

    const content = chunks.join('');
    const usage: ChatUsage = {
      inputTokens:
        reported.inputTokens ??
        estimateTokens(chatInput.messages.map((message) => message.content).join('\n')),
      outputTokens: reported.outputTokens ?? estimateTokens(content),
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
