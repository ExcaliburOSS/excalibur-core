import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatInput, ChatOutput } from '@excalibur/model-gateway';
import { ProviderError } from '@excalibur/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliDeps } from '../deps';
import { makeTempRepo, removeDir } from '../test-utils';
import {
  chatWithGuidance,
  loadGatewayContext,
  type GatewayContext,
} from './context';

const tempRepos: string[] = [];

afterEach(() => {
  while (tempRepos.length > 0) {
    const dir = tempRepos.pop();
    if (dir !== undefined) {
      removeDir(dir);
    }
  }
});

function repoWithProviders(yaml: string): string {
  const repo = makeTempRepo();
  tempRepos.push(repo);
  const dir = join(repo, '.excalibur', 'models');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'providers.yaml'), yaml, 'utf8');
  return repo;
}

interface RecordingDeps extends Pick<CliDeps, 'ui'> {
  warnings: string[];
}

function recordingDeps(): RecordingDeps {
  const warnings: string[] = [];
  const ui = {
    warn: (text: string): void => {
      warnings.push(text);
    },
  } as unknown as CliDeps['ui'];
  return { ui, warnings };
}

const input: ChatInput = { messages: [{ role: 'user', content: 'hello' }] };

const mockOutput: ChatOutput = {
  content: '> Mock provider (M1) — output.',
  model: 'mock-model',
  usage: { inputTokens: 1, outputTokens: 5 },
  costCents: null,
  finishReason: 'stop',
};

/** Builds a GatewayContext whose chat() throws the given error. */
function throwingContext(error: unknown): GatewayContext {
  return {
    gateway: {
      chat: async (): Promise<ChatOutput> => {
        throw error;
      },
      stream: (): AsyncIterable<never> => ({
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<never>> => Promise.reject(error),
          };
        },
      }),
    } as unknown as GatewayContext['gateway'],
    providers: { providers: { default: 'p', p: { type: 'anthropic' } } } as never,
    providersPath: null,
    providerName: 'p',
  };
}

describe('loadGatewayContext real-provider wiring', () => {
  it('constructs a real adapter for a configured provider (no network until chat)', () => {
    const repo = repoWithProviders(
      [
        'providers:',
        '  default: local',
        '  local:',
        '    type: ollama',
        '    model: llama3',
        '',
      ].join('\n'),
    );
    const context = loadGatewayContext(repo);
    expect(context.providerName).toBe('local');
    // The gateway resolves the real Ollama adapter lazily; constructing it must
    // not throw (ollama needs no key) and must not hit the network here.
    expect(() => context.gateway).not.toThrow();
  });

  it('keeps the mock default working with no providers.yaml', async () => {
    const repo = makeTempRepo();
    tempRepos.push(repo);
    const context = loadGatewayContext(repo);
    const output = await context.gateway.chat(input);
    expect(output.content).toContain('Mock provider (M1)');
  });
});

describe('chatWithGuidance error handling', () => {
  it('returns the provider output on success', async () => {
    const deps = recordingDeps();
    const context: GatewayContext = {
      gateway: { chat: async () => mockOutput } as unknown as GatewayContext['gateway'],
      providers: {} as never,
      providersPath: null,
      providerName: 'local',
    };
    const result = await chatWithGuidance(deps as unknown as CliDeps, context, input);
    expect(result.provider).toBe('local');
    expect(deps.warnings).toHaveLength(0);
  });

  it('falls back to mock on provider_not_implemented', async () => {
    const deps = recordingDeps();
    const context = throwingContext(
      new ProviderError('not impl', { code: 'provider_not_implemented' }),
    );
    const result = await chatWithGuidance(deps as unknown as CliDeps, context, input);
    expect(result.provider).toBe('mock');
    expect(result.output.content).toContain('Mock provider (M1)');
    expect(deps.warnings.join(' ')).toContain('mock provider');
  });

  it('falls back to mock on provider_not_found', async () => {
    const deps = recordingDeps();
    const context = throwingContext(
      new ProviderError('missing', { code: 'provider_not_found' }),
    );
    const result = await chatWithGuidance(deps as unknown as CliDeps, context, input);
    expect(result.provider).toBe('mock');
    expect(deps.warnings.join(' ')).toContain('models setup');
  });

  it('surfaces auth_failed instead of masking it behind the mock', async () => {
    const deps = recordingDeps();
    const context = throwingContext(new ProviderError('bad key', { code: 'auth_failed' }));
    await expect(
      chatWithGuidance(deps as unknown as CliDeps, context, input),
    ).rejects.toMatchObject({ code: 'auth_failed' });
    expect(deps.warnings).toHaveLength(0);
  });

  it('surfaces invalid_request instead of masking it', async () => {
    const deps = recordingDeps();
    const context = throwingContext(new ProviderError('bad', { code: 'invalid_request' }));
    await expect(
      chatWithGuidance(deps as unknown as CliDeps, context, input),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('re-throws non-ProviderError failures', async () => {
    const deps = recordingDeps();
    const context = throwingContext(new Error('boom'));
    await expect(
      chatWithGuidance(deps as unknown as CliDeps, context, input),
    ).rejects.toThrow('boom');
  });
});
