/**
 * Tests for the OSS-4 (M2) ADDITIVE key-injection surface: a host that keeps
 * keys outside `process.env` (e.g. encrypted in a database) supplies the
 * decrypted key directly via `keyResolver` / the factory `apiKey` dep, and the
 * real adapter uses it. Env-var resolution remains the default and is unchanged.
 *
 * Everything here runs offline against the mocked `QueueTransport`; no real key
 * or network is ever touched.
 */

import { ProviderError } from '@excalibur/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeResponse, fixture, QueueTransport } from '../__fixtures__/fake-transport';
import { redactSecrets } from '../redaction/redaction';
import type { ChatInput } from '../types';
import { AnthropicAdapter } from './anthropic-provider';
import { CORE_PROVIDER_FACTORIES } from './core-factories';
import { createProvider } from './create-provider';
import { OpenAICompatibleAdapter } from './openai-compatible-provider';

const chatInput: ChatInput = { messages: [{ role: 'user', content: 'hello' }] };

// A realistic-looking injected key (NOT from env) that the redactor masks.
const INJECTED_KEY = 'sk-ant-INJECTED1234567890abcdefINJECTED';
const ENV_KEY = 'sk-proj-ENVKEY1234567890abcdefENVKEY';
const KEY_ENV = 'TEST_KEY_INJECTION_ENV';

afterEach(() => {
  delete process.env[KEY_ENV];
});

describe('createProvider with an injected key (keyResolver / factory apiKey)', () => {
  it('an injected key reaches the real anthropic adapter (no env var set)', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = createProvider(
      'anthropic',
      { type: 'anthropic', model: 'claude-test', baseUrl: 'https://api.example.test' },
      {
        transport,
        factories: CORE_PROVIDER_FACTORIES,
        keyResolver: () => INJECTED_KEY,
      },
    );
    expect(adapter).toBeInstanceOf(AnthropicAdapter);

    await adapter.chat(chatInput);

    const sent = transport.requests[0]?.request;
    expect(sent?.headers?.['x-api-key']).toBe(INJECTED_KEY);
  });

  it('an injected key reaches the real openai-compatible adapter as a Bearer token', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = createProvider(
      'qwen',
      {
        type: 'openai-compatible',
        baseUrl: 'https://api.example.test/v1',
        model: 'test-openai-model',
      },
      {
        transport,
        factories: CORE_PROVIDER_FACTORIES,
        keyResolver: () => INJECTED_KEY,
      },
    );
    expect(adapter).toBeInstanceOf(OpenAICompatibleAdapter);

    await adapter.chat(chatInput);

    const sent = transport.requests[0]?.request;
    expect(sent?.headers?.['authorization']).toBe(`Bearer ${INJECTED_KEY}`);
  });

  it('the injected key wins over an env var when both are present', async () => {
    process.env[KEY_ENV] = ENV_KEY;
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = createProvider(
      'anthropic',
      { type: 'anthropic', apiKeyEnv: KEY_ENV, model: 'claude-test', baseUrl: 'https://x' },
      {
        transport,
        factories: CORE_PROVIDER_FACTORIES,
        keyResolver: () => INJECTED_KEY,
      },
    );
    await adapter.chat(chatInput);

    const header = transport.requests[0]?.request.headers?.['x-api-key'];
    expect(header).toBe(INJECTED_KEY);
    expect(header).not.toBe(ENV_KEY);
  });

  it('a redacted error never echoes the injected key', async () => {
    // 401 body echoes the key; the adapter must redact it before it lands in details.
    const transport = new QueueTransport([
      fakeResponse({
        status: 401,
        ok: false,
        body: JSON.stringify({ error: `bad key ${INJECTED_KEY}` }),
      }),
    ]);
    const adapter = createProvider(
      'anthropic',
      { type: 'anthropic', model: 'claude-test', baseUrl: 'https://x', maxRetries: 0 },
      {
        transport,
        factories: CORE_PROVIDER_FACTORIES,
        keyResolver: () => INJECTED_KEY,
      },
    );

    let caught: unknown;
    try {
      await adapter.chat(chatInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const serialized = JSON.stringify((caught as ProviderError).details ?? {});
    expect(serialized).not.toContain(INJECTED_KEY);
    // Sanity: the redactor would have masked this very key.
    expect(redactSecrets(INJECTED_KEY)).toBe('[REDACTED]');
  });

  it('keyResolver returning null falls back to env-var resolution (unchanged)', async () => {
    process.env[KEY_ENV] = ENV_KEY;
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = createProvider(
      'anthropic',
      { type: 'anthropic', apiKeyEnv: KEY_ENV, model: 'claude-test', baseUrl: 'https://x' },
      {
        transport,
        factories: CORE_PROVIDER_FACTORIES,
        keyResolver: () => null,
      },
    );
    await adapter.chat(chatInput);

    expect(transport.requests[0]?.request.headers?.['x-api-key']).toBe(ENV_KEY);
  });

  it('without a keyResolver, env-var resolution is byte-identical to before', async () => {
    process.env[KEY_ENV] = ENV_KEY;
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = createProvider(
      'anthropic',
      { type: 'anthropic', apiKeyEnv: KEY_ENV, model: 'claude-test', baseUrl: 'https://x' },
      { transport, factories: CORE_PROVIDER_FACTORIES },
    );
    await adapter.chat(chatInput);

    expect(transport.requests[0]?.request.headers?.['x-api-key']).toBe(ENV_KEY);
  });
});
