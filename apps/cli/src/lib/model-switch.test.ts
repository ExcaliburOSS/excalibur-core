import { describe, expect, it } from 'vitest';
import { capabilityHint, listSwitchableProviders, providerHint } from './model-switch';

/** P1.14c — pure logic behind the in-shell `/models` picker. */

const section = {
  default: 'kimi',
  cheap: 'kimi-fast',
  kimi: { type: 'openai-compatible', model: 'kimi-k2.7-code', capabilities: { reasoning: true, tools: true } },
  'kimi-fast': { type: 'openai-compatible', model: 'moonshot-v1-8k' },
  groq: { type: 'openai-compatible', model: 'openai/gpt-oss-120b', capabilities: { reasoning: true, tools: true } },
  mock: { type: 'mock' },
};

describe('listSwitchableProviders', () => {
  it('lists named providers, excludes default/cheap pointers and mock, marks current', () => {
    const list = listSwitchableProviders(section, 'kimi');
    const names = list.map((p) => p.name);
    expect(names).toEqual(['kimi', 'kimi-fast', 'groq']); // no 'default'/'cheap'/'mock'
    expect(list.find((p) => p.name === 'kimi')?.current).toBe(true);
    expect(list.find((p) => p.name === 'groq')?.current).toBe(false);
  });

  it('carries model + capabilities through', () => {
    const groq = listSwitchableProviders(section, 'kimi').find((p) => p.name === 'groq');
    expect(groq?.model).toBe('openai/gpt-oss-120b');
    expect(groq?.capabilities).toEqual({ reasoning: true, tools: true });
  });

  it('returns an empty list when only reserved pointers + mock exist', () => {
    expect(listSwitchableProviders({ default: 'mock', mock: { type: 'mock' } }, 'mock')).toEqual([]);
  });

  it('excludes the cheap-pointer target (the reasoning-off -fast sidecar)', () => {
    // Passing the cheap target hides kimi-fast so it can't be picked as the main model.
    const list = listSwitchableProviders(section, 'kimi', 'kimi-fast');
    expect(list.map((p) => p.name)).toEqual(['kimi', 'groq']);
    expect(list.some((p) => p.name === 'kimi-fast')).toBe(false);
  });
});

describe('capabilityHint / providerHint', () => {
  it('formats declared capabilities', () => {
    expect(capabilityHint({ reasoning: true, vision: true, tools: true })).toBe(
      'reasoning · vision · tools',
    );
    expect(capabilityHint({ reasoning: true })).toBe('reasoning');
    expect(capabilityHint(undefined)).toBe('');
    expect(capabilityHint({})).toBe('');
  });

  it('providerHint joins model + capabilities, omitting empties', () => {
    expect(
      providerHint({ name: 'x', model: 'm', capabilities: { tools: true }, current: false }),
    ).toBe('m · tools');
    expect(providerHint({ name: 'x', model: 'm', current: false })).toBe('m');
    expect(providerHint({ name: 'x', current: false })).toBe('');
  });
});
