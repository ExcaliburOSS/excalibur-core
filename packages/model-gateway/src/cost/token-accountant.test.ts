import { describe, expect, it } from 'vitest';
import { budgetExceeded, estimateMessagesTokens, usableBudget } from './token-accountant';

describe('token accountant', () => {
  it('estimateMessagesTokens sums estimateTokens (ceil(len/4)) across items', () => {
    // 40 chars → 10 tokens each.
    const items = [{ content: 'a'.repeat(40) }, { content: 'b'.repeat(40) }];
    expect(estimateMessagesTokens(items)).toBe(20);
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('usableBudget = contextWindow − reserve, never negative', () => {
    expect(usableBudget({ contextWindow: 100, reserveTokens: 30 })).toBe(70);
    expect(usableBudget({ contextWindow: 10, reserveTokens: 50 })).toBe(0);
  });

  it('budgetExceeded fires strictly above the usable budget', () => {
    const budget = { contextWindow: 100, reserveTokens: 30 }; // usable 70
    expect(budgetExceeded(71, budget)).toBe(true);
    expect(budgetExceeded(70, budget)).toBe(false);
    expect(budgetExceeded(0, budget)).toBe(false);
  });
});
