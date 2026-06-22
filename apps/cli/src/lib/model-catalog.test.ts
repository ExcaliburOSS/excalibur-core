import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG, catalogEntry } from './model-catalog';

const ENV_VAR = /^[A-Z_][A-Z0-9_]*$/;

describe('PROVIDER_CATALOG integrity', () => {
  it('has unique, non-empty keys and labels', () => {
    const keys = PROVIDER_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(0);
    }
  });

  it('uses valid provider types and well-formed key env var names', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(['openai-compatible', 'anthropic', 'ollama']).toContain(entry.type);
      expect(entry.apiKeyEnv).toMatch(ENV_VAR);
      // openai-compatible providers need a baseUrl; the anthropic adapter has its own.
      if (entry.type === 'openai-compatible') {
        expect(entry.baseUrl, `${entry.key} baseUrl`).toMatch(/^https?:\/\//);
      }
    }
  });

  it('every pair has a distinct good + fast model and a low-latency note', () => {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.pair === undefined) {
        continue;
      }
      expect(entry.pair.good.length).toBeGreaterThan(0);
      expect(entry.pair.fast.length).toBeGreaterThan(0);
      expect(entry.pair.good).not.toBe(entry.pair.fast);
      expect(entry.pair.fastLowLatency.length).toBeGreaterThan(0);
    }
  });

  it('subscription entries are internally consistent', () => {
    for (const entry of PROVIDER_CATALOG) {
      const sub = entry.subscription;
      if (sub === undefined) {
        continue;
      }
      expect(['sanctioned', 'gray', 'prohibited']).toContain(sub.risk);
      if (sub.kind === 'subscription-key') {
        // A sanctioned subscription key needs an endpoint + model + key env.
        expect(sub.keyConfig?.baseUrl).toMatch(/^https?:\/\//);
        expect((sub.keyConfig?.model ?? '').length).toBeGreaterThan(0);
        expect(sub.keyConfig?.apiKeyEnv ?? '').toMatch(ENV_VAR);
      } else {
        // cli-passthrough must name the CLI to drive and disclose the risk.
        expect((sub.cli?.command ?? '').length).toBeGreaterThan(0);
        expect((sub.cli?.loginHint ?? '').length).toBeGreaterThan(0);
        expect((sub.disclaimer ?? '').length).toBeGreaterThan(0);
      }
    }
  });

  it('leads with the sanctioned coding-subscription providers: Kimi, MiniMax, GLM', () => {
    expect(PROVIDER_CATALOG[0]?.key).toBe('kimi');
    expect(PROVIDER_CATALOG[1]?.key).toBe('minimax');
    expect(PROVIDER_CATALOG[2]?.key).toBe('glm');
    for (const key of ['minimax', 'glm']) {
      expect(catalogEntry(key)?.subscription?.kind).toBe('subscription-key');
      expect(catalogEntry(key)?.subscription?.risk).toBe('sanctioned');
    }
  });

  it('Kimi is the recommended subscription-key provider; Anthropic is cli-passthrough', () => {
    expect(catalogEntry('kimi')?.subscription?.kind).toBe('subscription-key');
    expect(catalogEntry('anthropic')?.subscription?.kind).toBe('cli-passthrough');
    expect(catalogEntry('anthropic')?.subscription?.risk).toBe('prohibited');
    // API-only providers have no subscription branch.
    expect(catalogEntry('deepseek')?.subscription).toBeUndefined();
  });

  it('includes the P1.14 providers (broad catalog)', () => {
    for (const key of ['groq', 'xai', 'cerebras', 'together', 'fireworks']) {
      const entry = catalogEntry(key);
      expect(entry, key).toBeDefined();
      expect(entry?.pair?.good.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('declared capabilities are well-formed booleans (P1.14)', () => {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.capabilities === undefined) continue;
      for (const value of Object.values(entry.capabilities)) {
        expect(typeof value).toBe('boolean');
      }
    }
    // Spot-check a few known capabilities.
    expect(catalogEntry('anthropic')?.capabilities?.vision).toBe(true);
    expect(catalogEntry('kimi')?.capabilities?.reasoning).toBe(true);
  });
});
