/**
 * Context-budget accounting for compaction (plan §"Compactación de contexto").
 *
 * The gateway knows each provider's `contextWindow`; the accountant turns that
 * into a usable budget (`contextWindow − reserveTokens`) and decides when the
 * accumulated conversation must be compacted. Token counts use the same
 * `estimateTokens` heuristic the mock provider and usage normalization use, so
 * the slice is fully demonstrable WITHOUT a real model (real per-adapter token
 * counting arrives in M2).
 */

import { estimateTokens } from './cost';

/** Anything with text content (a chat message or a transcript entry). */
export interface HasContent {
  content: string;
}

/** Estimated total tokens across a list of text-bearing items. */
export function estimateMessagesTokens(items: ReadonlyArray<HasContent>): number {
  let total = 0;
  for (const item of items) {
    total += estimateTokens(item.content);
  }
  return total;
}

/** A model's usable context budget: the window minus a safety reserve. */
export interface ContextBudget {
  /** The model's advertised context window, in tokens. */
  contextWindow: number;
  /** Tokens held back from the window (for the reply + headroom). */
  reserveTokens: number;
}

/** Usable tokens before compaction must trigger (never negative). */
export function usableBudget(budget: ContextBudget): number {
  return Math.max(0, budget.contextWindow - budget.reserveTokens);
}

/** True when the used tokens exceed the usable budget (compaction should fire). */
export function budgetExceeded(usedTokens: number, budget: ContextBudget): boolean {
  return usedTokens > usableBudget(budget);
}
