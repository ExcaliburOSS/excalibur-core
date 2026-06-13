import type { ProviderConfig } from '../providers/providers-file';
import type { ChatUsage } from '../types';

/**
 * Token estimation and cost computation (Build Contract §4.3).
 */

/** Rough token estimate pinned by the contract: ceil(length / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Computes the cost of a call in cents from the provider's per-million-token
 * rates. Returns `null` when the provider has no cost metadata at all; a
 * missing input or output rate is treated as 0 when the other is configured
 * (e.g. free local inference billed on one side only).
 */
export function computeCostCents(
  usage: ChatUsage,
  cfg: Pick<ProviderConfig, 'inputCostPerMillionTokensCents' | 'outputCostPerMillionTokensCents'>,
): number | null {
  const inputRate = cfg.inputCostPerMillionTokensCents;
  const outputRate = cfg.outputCostPerMillionTokensCents;
  if (inputRate === undefined && outputRate === undefined) {
    return null;
  }
  const cents =
    (usage.inputTokens * (inputRate ?? 0) + usage.outputTokens * (outputRate ?? 0)) / 1_000_000;
  // Avoid floating-point noise in stored artifacts (model-calls.jsonl).
  return Math.round(cents * 1e6) / 1e6;
}
