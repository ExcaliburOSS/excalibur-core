/**
 * Token-usage normalization for the real provider adapters.
 *
 * Provider-reported token counts are authoritative; when a provider omits one
 * (or streams without a final usage chunk), we fall back to the contract's
 * `estimateTokens` heuristic over the actual input/output text. The gateway
 * then overlays cost from the provider's per-token rates
 * (`computeCostCents`), so adapters return real `usage` and leave costing to
 * the gateway.
 */

import type { ChatUsage } from '../types';
import { estimateTokens } from './cost';

/** Text used to estimate a count the provider did not report. */
export interface UsageFallback {
  inputText: string;
  outputText: string;
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Prefers `reported` token counts; falls back to `estimateTokens` over the
 * fallback text for any count the provider did not supply.
 */
export function normalizeUsage(
  reported: Partial<ChatUsage> | undefined,
  fallback: UsageFallback,
): ChatUsage {
  const inputTokens = isNonNegativeInteger(reported?.inputTokens)
    ? reported.inputTokens
    : estimateTokens(fallback.inputText);
  const outputTokens = isNonNegativeInteger(reported?.outputTokens)
    ? reported.outputTokens
    : estimateTokens(fallback.outputText);
  return { inputTokens, outputTokens };
}
