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
   * role to keep it low-latency (e.g. disable reasoning). Applied when the
   * `cheap` role is actually consumed (ghost/compaction wiring).
   */
  fastLowLatency: string;
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
  /** Verified good+fast pair for the API-key rail; absent → single-model only. */
  pair?: CatalogPair;
  /** Subscription path; absent → API-key only (e.g. Groq/DeepSeek/OpenRouter). */
  subscription?: CatalogSubscription;
}

/**
 * The catalog, in onboarding display order (OSS individual → the providers a dev
 * most likely already pays for first, then free/local, then the test mock).
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    hint: 'Claude Pro/Max subscription (via Claude Code) or API · Opus + Haiku',
    type: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
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
    pair: {
      good: 'gpt-5.5',
      fast: 'gpt-5.4-nano',
      fastLowLatency:
        "reasoning_effort='none' + capped max_output_tokens (nano is a reasoning-family model)",
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
    pair: {
      good: 'gemini-3.5-flash',
      fast: 'gemini-3.1-flash-lite',
      fastLowLatency:
        'set thinking level minimal on the fast role (the 3.x line are thinking models)',
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
    key: 'kimi',
    label: 'Kimi K2 (Moonshot) — recommended',
    hint: 'subscription key (Kimi Code) or API · kimi-k2.7-code',
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    contextWindow: 262144,
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
    key: 'groq',
    label: 'Groq — free tier',
    hint: 'your free signup key · API · gpt-oss + llama-8b-instant',
    type: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    pair: {
      good: 'openai/gpt-oss-120b',
      fast: 'llama-3.1-8b-instant',
      fastLowLatency: 'llama-3.1-8b-instant is genuinely fast & non-reasoning (no knob needed)',
    },
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    hint: 'API · v4-pro + v4-flash',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    pair: {
      good: 'deepseek-v4-pro',
      fast: 'deepseek-v4-flash',
      fastLowLatency:
        'v4-flash thinking DEFAULTS ON (auto-escalates for agent clients) — MUST send {"thinking":{"type":"disabled"}}',
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
      fastLowLatency: "thinking_level='minimal' on Flash Lite; use nitro/exacto routing",
    },
  },
];

/** Looks up a catalog entry by its key. */
export function catalogEntry(key: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.key === key);
}
