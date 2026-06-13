import { describe, expect, it } from 'vitest';
import { computeCostCents, estimateTokens } from './cost';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('is ceil(length / 4)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('a'.repeat(401))).toBe(101);
  });
});

describe('computeCostCents', () => {
  it('computes cost from input and output per-million-token rates', () => {
    const cost = computeCostCents(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { inputCostPerMillionTokensCents: 300, outputCostPerMillionTokensCents: 1500 },
    );
    expect(cost).toBe(1800);
  });

  it('computes fractional cents exactly for small usage', () => {
    const cost = computeCostCents(
      { inputTokens: 500, outputTokens: 200 },
      { inputCostPerMillionTokensCents: 100, outputCostPerMillionTokensCents: 200 },
    );
    // (500*100 + 200*200) / 1_000_000 = 0.09 cents
    expect(cost).toBe(0.09);
  });

  it('returns null when the provider has no cost metadata', () => {
    expect(computeCostCents({ inputTokens: 10, outputTokens: 10 }, {})).toBeNull();
  });

  it('treats a missing rate as 0 when the other rate is configured', () => {
    const cost = computeCostCents(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { outputCostPerMillionTokensCents: 50 },
    );
    expect(cost).toBe(50);
  });

  it('returns 0 (not null) for zero usage with configured rates', () => {
    const cost = computeCostCents(
      { inputTokens: 0, outputTokens: 0 },
      { inputCostPerMillionTokensCents: 100, outputCostPerMillionTokensCents: 100 },
    );
    expect(cost).toBe(0);
  });
});
