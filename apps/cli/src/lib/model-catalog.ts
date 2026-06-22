import type { ProviderType } from '@excalibur/model-gateway';

/**
 * Curated provider + model catalog for the comfortable onboarding (OSS, user
 * level). It encodes, per provider: how to connect (type/baseUrl/key env), the
 * verified GOOD + FAST model pair for one-key auto-config, the per-provider knob
 * that forces the fast role into a low-latency / non-reasoning mode, and the
 * SUBSCRIPTION path (a sanctioned subscription-backed API key, or driving the
 * vendor's official CLI — Excalibur never reimplements subscription OAuth).
 *
 * Model ids were adversarially verified mid-2026 but CHURN FAST — onboarding
 * should validate them against the provider's live `/v1/models` + deprecations
 * and fall back to the pinned id with a warning (see the workflow guardrails).
 * Excalibur never hosts or pays for a model: every path here runs on the user's
 * own key/account (pure BYOK) or their local/own-infra endpoint.
 */

/** Verified good + fast model pair reachable with ONE provider key. */
export interface CatalogPair {
  /** Coding/agent model (the `default` provider). */
  good: string;
  /** Fast/cheap model for ghost-text + compaction (the `cheap` provider). */
  fast: string;
  /**
   * Human-readable note describing the knob that MUST be applied to the fast
   * role to keep it low-latency (e.g. disable reasoning).
   */
  fastLowLatency: string;
  /**
   * Request-body params merged into the fast provider's call to disable/minimize
   * reasoning for low latency (written to the `cheap` provider's `extraBody`).
   * Absent → the fast model is already non-reasoning and needs no knob.
   */
  fastExtraBody?: Record<string, unknown>;
}

/** How a provider's subscription (vs pay-per-token API) can legitimately be used. */
export interface CatalogSubscription {
  /**
   * - `subscription-key`: the subscription is consumed via a normal API key that
   *   draws on the membership quota (sanctioned, full native Excalibur loop).
   * - `cli-passthrough`: the subscription is only reachable through the vendor's
   *   own client; Excalibur drives that official CLI (it holds the auth) and
   *   never stores/replays a token.
   */
  kind: 'subscription-key' | 'cli-passthrough';
  /** ToS posture of third-party subscription use for this provider. */
  risk: 'sanctioned' | 'gray' | 'prohibited';
  /** subscription-key: the endpoint/model/key that bills the subscription. */
  keyConfig?: { baseUrl: string; model: string; apiKeyEnv: string };
  /** cli-passthrough: the official CLI to drive + how the user logs into it. */
  cli?: { command: string; loginHint: string };
  /** One-line disclaimer shown in the subscription branch (gray/prohibited). */
  disclaimer?: string;
}

export interface ProviderCatalogEntry {
  /** Internal id + the `default` provider name written to providers.yaml. */
  key: string;
  /** Display label in the chooser. */
  label: string;
  /** Dim hint after the label. */
  hint: string;
  /** providers.yaml `type`. */
  type: ProviderType;
  /** Base URL for openai-compatible providers (the anthropic adapter has its own). */
  baseUrl?: string;
  /** Suggested API key env var NAME (never a value). */
  apiKeyEnv: string;
  contextWindow?: number;
  /**
   * Declared capabilities of the GOOD model (P1.14): written to the default
   * provider's `capabilities` in providers.yaml, surfaced by `excalibur models
   * list` and the in-shell `/models` picker. Absent → unknown / assume baseline.
   */
  capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean };
  /** Verified good+fast pair for the API-key rail; absent → single-model only. */
  pair?: CatalogPair;
  /** Subscription path; absent → API-key only (e.g. DeepSeek/OpenRouter). */
  subscription?: CatalogSubscription;
}

/**
 * The catalog, in onboarding display order (OSS individual → the providers a dev
 * most likely already pays for first, then free/local, then the test mock).
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    key: 'kimi',
    label: 'Kimi K2 (Moonshot) — recommended',
    hint: 'subscription key (Kimi Code) or API · kimi-k2.7-code',
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    contextWindow: 262144,
    capabilities: { reasoning: true, tools: true },
    pair: {
      good: 'kimi-k2.7-code',
      fast: 'moonshot-v1-8k',
      fastLowLatency:
        'moonshot-v1-8k is non-reasoning but only 8K ctx (weak fast pick); k2.7-code forces thinking on',
    },
    subscription: {
      kind: 'subscription-key',
      risk: 'sanctioned',
      keyConfig: {
        baseUrl: 'https://api.kimi.com/coding/v1',
        model: 'kimi-for-coding',
        apiKeyEnv: 'KIMI_CODE_API_KEY',
      },
    },
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    hint: 'subscription (MiniMax coding plan) or API · MiniMax-M2',
    type: 'openai-compatible',
    baseUrl: 'https://api.minimax.io/v1',
    apiKeyEnv: 'MINIMAX_API_KEY',
    capabilities: { reasoning: true, tools: true },
    pair: {
      good: 'MiniMax-M2',
      fast: 'MiniMax-Text-01',
      fastLowLatency:
        'MiniMax-Text-01 is a non-reasoning text model — fast for ghost-text/compaction',
    },
    subscription: {
      // The MiniMax coding plan is consumed via the normal platform API key
      // against the membership quota (sanctioned) — same endpoint, coding model.
      kind: 'subscription-key',
      risk: 'sanctioned',
      keyConfig: {
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M2',
        apiKeyEnv: 'MINIMAX_API_KEY',
      },
    },
  },
  {
    key: 'glm',
    label: 'GLM (Zhipu / Z.ai)',
    hint: 'GLM Coding Plan subscription or API · GLM-4.6',
    type: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
    contextWindow: 200000,
    capabilities: { reasoning: true, tools: true },
    pair: {
      good: 'glm-4.6',
      fast: 'glm-4.5-air',
      fastLowLatency:
        'glm-4.5-air is the lightweight fast variant; send {"thinking":{"type":"disabled"}} to keep it low-latency',
      fastExtraBody: { thinking: { type: 'disabled' } },
    },
    subscription: {
      // The GLM Coding Plan is a sanctioned subscription consumed via a coding
      // API key against the membership quota (own coding endpoint + model).
      kind: 'subscription-key',
      risk: 'sanctioned',
      keyConfig: {
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        model: 'glm-4.6',
        apiKeyEnv: 'ZAI_CODING_API_KEY',
      },
    },
  },
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    hint: 'Claude Pro/Max subscription (via Claude Code) or API · Opus + Haiku',
    type: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    capabilities: { reasoning: true, vision: true, tools: true },
    pair: {
      good: 'claude-opus-4-8',
      fast: 'claude-haiku-4-5',
      fastLowLatency: 'Haiku is fast & non-reasoning; leave thinking off + small max_tokens',
    },
    subscription: {
      kind: 'cli-passthrough',
      risk: 'prohibited',
      cli: {
        command: 'claude',
        loginHint: 'install Claude Code, then run `claude` to log in with Pro/Max',
      },
      disclaimer:
        'Anthropic does NOT permit third-party tools to use Pro/Max credentials on your behalf. Excalibur only drives Claude Code’s own CLI (it holds your login) and never stores or replays your token — your own automation, at your own risk.',
    },
  },
  {
    key: 'openai',
    label: 'OpenAI',
    hint: 'ChatGPT subscription (via Codex) or API · gpt-5.5 + nano',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    capabilities: { reasoning: true, vision: true, tools: true },
    pair: {
      good: 'gpt-5.5',
      fast: 'gpt-5.4-nano',
      fastLowLatency:
        "reasoning_effort='none' + capped max_output_tokens (nano is a reasoning-family model)",
      fastExtraBody: { reasoning_effort: 'none' },
    },
    subscription: {
      kind: 'cli-passthrough',
      risk: 'gray',
      cli: { command: 'codex', loginHint: 'install OpenAI Codex, then run `codex login`' },
      disclaimer:
        'Uses your ChatGPT subscription via OpenAI’s own Codex CLI (which holds your login). Subscription use is governed by OpenAI’s terms — at your own risk.',
    },
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    hint: 'AI Pro/Ultra subscription (via Gemini/Antigravity CLI), API, or free tier · Flash',
    type: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    capabilities: { reasoning: true, vision: true, tools: true },
    pair: {
      good: 'gemini-3.5-flash',
      fast: 'gemini-3.1-flash-lite',
      fastLowLatency:
        "reasoning_effort='minimal' (the floor on Gemini 3.x; 'none' is 2.5-only and 400s here)",
      fastExtraBody: { reasoning_effort: 'minimal' },
    },
    subscription: {
      kind: 'cli-passthrough',
      risk: 'prohibited',
      cli: {
        command: 'agy',
        loginHint: 'install Google’s Antigravity CLI (`agy`) and log in with AI Pro/Ultra',
      },
      disclaimer:
        'Google does NOT permit third-party tools to use your subscription; Excalibur only drives Google’s official CLI and never stores your token — at your own risk.',
    },
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    hint: 'API · v4-pro + v4-flash',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    capabilities: { reasoning: true, tools: true },
    pair: {
      good: 'deepseek-v4-pro',
      fast: 'deepseek-v4-flash',
      fastLowLatency:
        'v4-flash thinking DEFAULTS ON (auto-escalates for agent clients) — MUST send {"thinking":{"type":"disabled"}}',
      fastExtraBody: { thinking: { type: 'disabled' } },
    },
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    hint: 'one key, many models · API',
    type: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    pair: {
      good: 'anthropic/claude-opus-4.8',
      fast: 'google/gemini-3.1-flash-lite',
      fastLowLatency:
        "reasoning_effort='minimal' (the genuine floor; 'none' doesn't disable on this Gemini-3 model); use nitro/exacto routing",
      fastExtraBody: { reasoning_effort: 'minimal' },
    },
  },
  {
    key: 'groq',
    label: 'Groq',
    hint: 'free tier · ultra-fast inference · gpt-oss + Llama',
    type: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    contextWindow: 131072,
    capabilities: { reasoning: true, tools: true },
    pair: {
      // Verified against Groq's live /v1/models (mid-2026).
      good: 'openai/gpt-oss-120b',
      fast: 'llama-3.1-8b-instant',
      fastLowLatency: 'llama-3.1-8b-instant is non-reasoning and extremely fast on Groq',
    },
  },
  {
    key: 'xai',
    label: 'xAI (Grok)',
    hint: 'API · grok-4 + grok-4-fast',
    type: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    capabilities: { reasoning: true, vision: true, tools: true },
    pair: {
      good: 'grok-4',
      fast: 'grok-4-fast',
      fastLowLatency: 'grok-4-fast is the low-latency variant for ghost-text/compaction',
    },
  },
  {
    key: 'cerebras',
    label: 'Cerebras',
    hint: 'free tier · fastest inference (wafer-scale) · Qwen + Llama',
    type: 'openai-compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    capabilities: { reasoning: true, tools: true },
    pair: {
      good: 'qwen-3-coder-480b',
      fast: 'llama-3.3-70b',
      fastLowLatency: 'Cerebras serves all models at very low latency; the 70b is the snappy pick',
    },
  },
  {
    key: 'together',
    label: 'Together AI',
    hint: 'API · open models (DeepSeek, Qwen, Llama)',
    type: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    capabilities: { tools: true },
    pair: {
      good: 'deepseek-ai/DeepSeek-V3',
      fast: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      fastLowLatency: 'the Turbo Llama is the low-latency fast pick',
    },
  },
  {
    key: 'fireworks',
    label: 'Fireworks AI',
    hint: 'API · fast open-model serving',
    type: 'openai-compatible',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    capabilities: { tools: true },
    pair: {
      good: 'accounts/fireworks/models/deepseek-v3',
      fast: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      fastLowLatency: 'the 8b instruct model is the low-latency fast pick',
    },
  },
];

/** Looks up a catalog entry by its key. */
export function catalogEntry(key: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === key);
}
