import { ProviderError } from '@excalibur/shared';
import { describe, expect, it } from 'vitest';
import { computeCostCents } from '../cost/cost';
import {
  DEFAULT_PROVIDERS_CONFIG,
  type ProvidersFileConfig,
  type ProvidersSection,
} from '../providers/providers-file';
import type { ChatMessage } from '../types';
import { ModelGateway } from './gateway';

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are Excalibur.' },
  { role: 'user', content: 'Explain the release flow.' },
];

function config(providers: Record<string, unknown>): ProvidersFileConfig {
  return { providers: providers as ProvidersSection };
}

describe('ModelGateway provider resolution', () => {
  it('works out of the box with DEFAULT_PROVIDERS_CONFIG', async () => {
    const gateway = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
    const output = await gateway.chat({ messages });
    expect(output.content.startsWith('> Mock provider (M1)')).toBe(true);
    expect(output.finishReason).toBe('stop');
  });

  it('uses the configured default provider when none is specified', async () => {
    const gateway = new ModelGateway(
      config({
        default: 'mock',
        qwen: { type: 'openai-compatible', apiKeyEnv: 'QWEN_API_KEY' },
        mock: { type: 'mock', model: 'default-mock' },
      }),
    );
    const output = await gateway.chat({ messages });
    expect(output.model).toBe('default-mock');
  });

  it('an explicit provider name overrides the default', async () => {
    const gateway = new ModelGateway(
      config({
        default: 'qwen',
        qwen: { type: 'openai-compatible', apiKeyEnv: 'QWEN_API_KEY' },
        mock: { type: 'mock' },
      }),
    );
    // Default routes to the unimplemented real provider...
    await expect(gateway.chat({ messages })).rejects.toMatchObject({
      code: 'provider_not_implemented',
    });
    // ...while the explicit mock provider works.
    const output = await gateway.chat({ messages, provider: 'mock' });
    expect(output.content).toContain('Mock provider (M1)');
  });

  it('resolves a single configured provider without a default pointer', async () => {
    const gateway = new ModelGateway(config({ mock: { type: 'mock' } }));
    const output = await gateway.chat({ messages });
    expect(output.content).toContain('Mock provider (M1)');
  });

  it('rejects an unknown explicit provider with provider_not_found', async () => {
    const gateway = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
    const promise = gateway.chat({ messages, provider: 'gpt-9' });
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
    await expect(promise).rejects.toMatchObject({ code: 'provider_not_found' });
  });

  it('rejects when several providers exist and no default is configured', async () => {
    const gateway = new ModelGateway(
      config({ a: { type: 'mock' }, b: { type: 'mock' } }),
    );
    await expect(gateway.chat({ messages })).rejects.toMatchObject({
      code: 'provider_not_found',
    });
  });

  it('does not treat "default" itself as a provider name', async () => {
    const gateway = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
    await expect(gateway.chat({ messages, provider: 'default' })).rejects.toMatchObject({
      code: 'provider_not_found',
    });
  });
});

describe('ModelGateway cost and model handling', () => {
  it('computes costCents from the provider cost metadata', async () => {
    const providerCfg = {
      type: 'mock' as const,
      inputCostPerMillionTokensCents: 300,
      outputCostPerMillionTokensCents: 1500,
    };
    const gateway = new ModelGateway(config({ default: 'mock', mock: providerCfg }));
    const output = await gateway.chat({ messages });
    const expected = computeCostCents(output.usage, providerCfg);
    expect(output.costCents).toBe(expected);
    expect(output.costCents).not.toBeNull();
    expect(output.costCents ?? 0).toBeGreaterThan(0);
  });

  it('keeps costCents null when the provider has no cost metadata', async () => {
    const gateway = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
    const output = await gateway.chat({ messages });
    expect(output.costCents).toBeNull();
  });

  it('falls back to the provider-configured model when the input has none', async () => {
    const gateway = new ModelGateway(
      config({ default: 'mock', mock: { type: 'mock', model: 'mock-large' } }),
    );
    expect((await gateway.chat({ messages })).model).toBe('mock-large');
    expect((await gateway.chat({ messages, model: 'explicit' })).model).toBe('explicit');
  });
});

describe('ModelGateway.stream', () => {
  it('streams via the resolved provider and matches chat output', async () => {
    const gateway = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
    const chatOutput = await gateway.chat({ messages, metadata: { kind: 'plan' } });
    const deltas = [];
    for await (const delta of gateway.stream({ messages, metadata: { kind: 'plan' } })) {
      deltas.push(delta);
    }
    expect(deltas[deltas.length - 1]).toEqual({ content: '', done: true });
    expect(deltas.map((delta) => delta.content).join('')).toBe(chatOutput.content);
  });

  it('surfaces provider_not_implemented when streaming from a real provider', async () => {
    const gateway = new ModelGateway(
      config({ default: 'anthropic', anthropic: { type: 'anthropic' } }),
    );
    const iterate = async (): Promise<void> => {
      for await (const delta of gateway.stream({ messages })) {
        void delta;
      }
    };
    await expect(iterate()).rejects.toMatchObject({ code: 'provider_not_implemented' });
  });
});
