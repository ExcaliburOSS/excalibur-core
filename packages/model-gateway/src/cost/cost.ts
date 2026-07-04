import type { ProviderConfig } from '../providers/providers-file';
import type { ChatUsage } from '../types';
import { resolvePricing } from './model-pricing';

/**
 * Token estimation and cost computation (Build Contract §4.3).
 */

/** Rough token estimate pinned by the contract: ceil(length / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Computes the cost of a call in cents. Rates resolve as: an explicit provider
 * CONFIG rate (billing source of truth / negotiated Enterprise rates) ALWAYS wins;
 * otherwise the built-in list-price TABLE by model id (so cost is visible + roughly
 * right out of the box — no more silent $0 for an un-priced paid model); otherwise
 * `null` (genuinely UNKNOWN — the caller must render "—", never $0, so a paid model
 * whose price we don't know is never mistaken for free). `modelId` lets the caller
 * pass the effective model (which may differ from `cfg.model`); it defaults to
 * `cfg.model`.
 */
export function computeCostCents(
  usage: ChatUsage,
  cfg: Pick<
    ProviderConfig,
    'model' | 'inputCostPerMillionTokensCents' | 'outputCostPerMillionTokensCents'
  >,
  modelId?: string,
): number | null {
  const { rates } = resolvePricing(cfg, modelId);
  if (rates === null) {
    return null; // unknown price — never coerce to 0 (that hides real spend)
  }
  const cents = (usage.inputTokens * rates.input + usage.outputTokens * rates.output) / 1_000_000;
  // Avoid floating-point noise in stored artifacts (model-calls.jsonl).
  return Math.round(cents * 1e6) / 1e6;
}
