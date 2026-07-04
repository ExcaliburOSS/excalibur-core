import type { ProviderConfig } from '../providers/providers-file';

/**
 * DEFAULT model pricing — public list prices so cost "just works" out of the box,
 * instead of showing $0 for every model whose provider config omits rates (the
 * silent "looks free" bug: a genuinely-free local model and an un-priced paid API
 * both rendered $0.00, hiding real spend).
 *
 * Rates are **cents per MILLION tokens**, matched by a case-insensitive substring
 * of the model id (longest/most-specific pattern wins). These are APPROXIMATE
 * public list prices and DRIFT over time — they exist to make cost visible and
 * roughly right, NOT to be the billing source of truth. For accurate billing
 * (Enterprise chargeback, negotiated rates) set `inputCostPerMillionTokensCents` /
 * `outputCostPerMillionTokensCents` on the provider config: an explicit config
 * rate ALWAYS overrides this table (see {@link resolvePricing}).
 */
/**
 * When the bundled table was last reviewed. Prices DRIFT, so this is stamped so
 * the UI can warn "prices as of {PRICING_AS_OF} — may be stale; set your rate in
 * config or drop a .excalibur/pricing.json". The bundled table is a convenience
 * default, never the billing source of truth.
 */
export const PRICING_AS_OF = '2026-07';

export interface ModelRates {
  /** Cents per million INPUT (prompt) tokens. */
  input: number;
  /** Cents per million OUTPUT (completion) tokens. */
  output: number;
}

/** A pricing entry: rates + the lower-cased substring matched against a model id.
 * A local `.excalibur/pricing.json` (or org policy file) supplies these to OVERRIDE
 * the bundled table WITHOUT a code release — the answer to prices changing. */
export interface PricingOverride extends ModelRates {
  /** Substring matched (case-insensitively) against the model id. */
  match: string;
}

type PricingRow = PricingOverride;

// Ordered MOST-SPECIFIC first so `gpt-4o-mini` beats `gpt-4o`, etc. USD list prices
// as cents/M: e.g. $3.00 /M input = 300 cents/M. Approximate — override in config.
const PRICING: readonly PricingRow[] = [
  // Anthropic Claude
  { match: 'claude-opus', input: 1500, output: 7500 },
  { match: 'claude-sonnet', input: 300, output: 1500 },
  { match: 'claude-haiku', input: 80, output: 400 },
  { match: 'claude-3-opus', input: 1500, output: 7500 },
  { match: 'claude-3-5-sonnet', input: 300, output: 1500 },
  { match: 'claude-3-5-haiku', input: 80, output: 400 },
  { match: 'claude', input: 300, output: 1500 },
  // OpenAI
  { match: 'gpt-4o-mini', input: 15, output: 60 },
  { match: 'gpt-4o', input: 250, output: 1000 },
  { match: 'gpt-4.1-mini', input: 40, output: 160 },
  { match: 'gpt-4.1', input: 200, output: 800 },
  { match: 'o4-mini', input: 110, output: 440 },
  { match: 'o3-mini', input: 110, output: 440 },
  { match: 'o3', input: 200, output: 800 },
  { match: 'gpt-4', input: 3000, output: 6000 },
  { match: 'gpt-3.5', input: 50, output: 150 },
  // Moonshot / Kimi (the user's provider) — moonshot.ai list prices, approximate
  { match: 'kimi-k2', input: 60, output: 250 },
  { match: 'kimi', input: 60, output: 250 },
  { match: 'moonshot-v1-128k', input: 200, output: 200 },
  { match: 'moonshot-v1-32k', input: 100, output: 100 },
  { match: 'moonshot-v1-8k', input: 20, output: 20 },
  { match: 'moonshot', input: 100, output: 100 },
  // Google Gemini
  { match: 'gemini-1.5-flash', input: 8, output: 30 },
  { match: 'gemini-1.5-pro', input: 125, output: 500 },
  { match: 'gemini-2.0-flash', input: 10, output: 40 },
  { match: 'gemini-2.5-pro', input: 125, output: 1000 },
  { match: 'gemini', input: 50, output: 150 },
  // DeepSeek
  { match: 'deepseek-reasoner', input: 55, output: 219 },
  { match: 'deepseek-chat', input: 27, output: 110 },
  { match: 'deepseek', input: 27, output: 110 },
  // Mistral / open-weights hosted
  { match: 'mistral-large', input: 200, output: 600 },
  { match: 'mistral', input: 20, output: 60 },
  { match: 'llama', input: 20, output: 60 },
  { match: 'qwen', input: 20, output: 60 },
];

/** Where a call's pricing came from — recorded per call for auditability. */
export type PricingSource = 'config' | 'table' | 'unknown';

/**
 * Looks up default list-price rates for a model id (case-insensitive, longest
 * substring match), or `null` when unknown. A LOCAL/free provider (e.g. ollama)
 * legitimately has no entry — it should carry explicit `0` rates in config to read
 * as $0 rather than "unknown".
 */
export function resolveModelPricing(
  modelId: string | undefined,
  overrides: readonly PricingOverride[] = [],
): ModelRates | null {
  if (modelId === undefined || modelId.length === 0) {
    return null;
  }
  const id = modelId.toLowerCase();
  // Local/org OVERRIDES are checked first (they beat the bundled table at equal
  // specificity), then the bundled list-price table. Longest match wins in each.
  const best = (rows: readonly PricingRow[]): PricingRow | null => {
    let winner: PricingRow | null = null;
    for (const row of rows) {
      if (
        id.includes(row.match.toLowerCase()) &&
        (winner === null || row.match.length > winner.match.length)
      ) {
        winner = row;
      }
    }
    return winner;
  };
  const hit = best(overrides) ?? best(PRICING);
  return hit === null ? null : { input: hit.input, output: hit.output };
}

/**
 * Parses a `.excalibur/pricing.json` override file into {@link PricingOverride}s.
 * Shape: `{ "asOf"?: string, "models": { "<match>": { "input": <cents/M>,
 * "output": <cents/M> } } }`. Best-effort + total: a malformed file or entry is
 * skipped, never thrown — a bad pricing file must not break model calls. Pure.
 */
export function parsePricingOverrides(raw: unknown): PricingOverride[] {
  if (typeof raw !== 'object' || raw === null) {
    return [];
  }
  const models = (raw as { models?: unknown }).models;
  if (typeof models !== 'object' || models === null) {
    return [];
  }
  const out: PricingOverride[] = [];
  for (const [match, value] of Object.entries(models as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as { input?: unknown; output?: unknown };
    const input =
      typeof v.input === 'number' && Number.isFinite(v.input) && v.input >= 0 ? v.input : undefined;
    const output =
      typeof v.output === 'number' && Number.isFinite(v.output) && v.output >= 0
        ? v.output
        : undefined;
    if (match.trim().length > 0 && input !== undefined && output !== undefined) {
      out.push({ match: match.trim(), input, output });
    }
  }
  return out;
}

/**
 * Resolves the effective per-million rates for a call and WHERE they came from:
 * an explicit config rate ALWAYS wins (billing source of truth / negotiated
 * Enterprise rates); otherwise the built-in table by model id; otherwise unknown
 * (cost cannot be computed — it must read as "—", never $0). A config that sets
 * only ONE side leaves the other at that config side (the caller treats a missing
 * side as 0), so an explicit partial config is honoured verbatim.
 */
export function resolvePricing(
  cfg: Pick<
    ProviderConfig,
    'model' | 'inputCostPerMillionTokensCents' | 'outputCostPerMillionTokensCents'
  >,
  modelId?: string,
  overrides: readonly PricingOverride[] = [],
): { rates: ModelRates; source: PricingSource } | { rates: null; source: 'unknown' } {
  const hasConfig =
    cfg.inputCostPerMillionTokensCents !== undefined ||
    cfg.outputCostPerMillionTokensCents !== undefined;
  if (hasConfig) {
    return {
      rates: {
        input: cfg.inputCostPerMillionTokensCents ?? 0,
        output: cfg.outputCostPerMillionTokensCents ?? 0,
      },
      source: 'config',
    };
  }
  const table = resolveModelPricing(modelId ?? cfg.model, overrides);
  if (table !== null) {
    return { rates: table, source: 'table' };
  }
  return { rates: null, source: 'unknown' };
}
