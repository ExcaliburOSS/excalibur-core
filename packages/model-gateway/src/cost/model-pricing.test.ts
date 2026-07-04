import { describe, expect, it } from 'vitest';
import { parsePricingOverrides, resolveModelPricing, resolvePricing } from './model-pricing';

describe('resolveModelPricing (#cost — built-in list-price table)', () => {
  it('matches by case-insensitive substring, longest pattern wins', () => {
    // gpt-4o-mini must beat the shorter gpt-4o.
    expect(resolveModelPricing('gpt-4o-mini')).toEqual({ input: 15, output: 60 });
    expect(resolveModelPricing('gpt-4o')).toEqual({ input: 250, output: 1000 });
    // real-world ids with suffixes/prefixes still match.
    expect(resolveModelPricing('kimi-k2.7-code')).toEqual({ input: 60, output: 250 });
    expect(resolveModelPricing('anthropic/claude-3-5-sonnet-20241022')).toEqual({
      input: 300,
      output: 1500,
    });
  });

  it('returns null for an unknown or empty model', () => {
    expect(resolveModelPricing('some-private-llm')).toBeNull();
    expect(resolveModelPricing('')).toBeNull();
    expect(resolveModelPricing(undefined)).toBeNull();
  });
});

describe('resolvePricing (config > table > unknown)', () => {
  it('an explicit config rate is the source of truth (Enterprise negotiated rates)', () => {
    const r = resolvePricing({
      model: 'kimi-k2',
      inputCostPerMillionTokensCents: 42,
      outputCostPerMillionTokensCents: 84,
    });
    expect(r).toEqual({ rates: { input: 42, output: 84 }, source: 'config' });
  });

  it('a partial config rate is honoured verbatim (the other side = 0)', () => {
    const r = resolvePricing({ model: 'kimi-k2', outputCostPerMillionTokensCents: 50 });
    expect(r).toEqual({ rates: { input: 0, output: 50 }, source: 'config' });
  });

  it('falls back to the table by model id when config omits rates', () => {
    expect(resolvePricing({ model: 'claude-opus-4' })).toEqual({
      rates: { input: 1500, output: 7500 },
      source: 'table',
    });
    // an explicit modelId argument overrides cfg.model.
    expect(resolvePricing({ model: 'default' }, 'gpt-4o-mini')).toEqual({
      rates: { input: 15, output: 60 },
      source: 'table',
    });
  });

  it('is UNKNOWN (null rates, never $0) when neither config nor table knows the price', () => {
    expect(resolvePricing({ model: 'acme-internal-llm' })).toEqual({
      rates: null,
      source: 'unknown',
    });
    expect(resolvePricing({})).toEqual({ rates: null, source: 'unknown' });
  });
});

describe('pricing overrides (#cost — fix a changed price WITHOUT a code release)', () => {
  it('parsePricingOverrides reads the { models } map and skips malformed entries', () => {
    const rows = parsePricingOverrides({
      asOf: '2026-09',
      models: {
        'kimi-k2': { input: 99, output: 199 },
        badType: { input: 'x', output: 1 }, // non-number → skipped
        partial: { input: 5 }, // missing output → skipped
      },
    });
    expect(rows).toEqual([{ match: 'kimi-k2', input: 99, output: 199 }]);
    expect(parsePricingOverrides(null)).toEqual([]);
    expect(parsePricingOverrides({ nothing: 1 })).toEqual([]);
  });

  it('an override BEATS the bundled table, but config still beats the override', () => {
    const overrides = [{ match: 'kimi-k2', input: 99, output: 199 }];
    // override wins over the stale bundled table for the same model
    expect(resolveModelPricing('kimi-k2.7-code', overrides)).toEqual({ input: 99, output: 199 });
    expect(resolvePricing({ model: 'kimi-k2' }, undefined, overrides)).toEqual({
      rates: { input: 99, output: 199 },
      source: 'table',
    });
    // a provider-config rate is STILL the source of truth over the override
    expect(
      resolvePricing({ model: 'kimi-k2', inputCostPerMillionTokensCents: 5 }, undefined, overrides)
        .source,
    ).toBe('config');
  });
});
