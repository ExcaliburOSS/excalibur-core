import { describe, expect, it } from 'vitest';
import { detectEnvProviders } from './provider-setup';

describe('detectEnvProviders', () => {
  it('finds nothing with a bare environment', () => {
    expect(detectEnvProviders({})).toEqual([]);
  });

  it('detects a pay-per-token API key (rail: api)', () => {
    const found = detectEnvProviders({ DEEPSEEK_API_KEY: 'sk-x' });
    expect(found).toHaveLength(1);
    expect(found[0]?.entry.key).toBe('deepseek');
    expect(found[0]?.rail).toBe('api');
    expect(found[0]?.envVar).toBe('DEEPSEEK_API_KEY');
  });

  it('prefers a sanctioned subscription-key env var over the API one', () => {
    // Kimi: KIMI_CODE_API_KEY (subscription) wins over MOONSHOT_API_KEY (api).
    const found = detectEnvProviders({ KIMI_CODE_API_KEY: 'sk-x', MOONSHOT_API_KEY: 'sk-y' });
    const kimi = found.find((d) => d.entry.key === 'kimi');
    expect(kimi?.rail).toBe('subscription');
    expect(kimi?.envVar).toBe('KIMI_CODE_API_KEY');
  });

  it('returns one entry per provider, in catalog order', () => {
    const found = detectEnvProviders({ ANTHROPIC_API_KEY: 'a', GROQ_API_KEY: 'g' });
    expect(found.map((d) => d.entry.key)).toEqual(['anthropic', 'groq']);
  });
});
