import { ConfigValidationError, ProviderError } from '@excalibur/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deterministicHooks,
  fakeResponse,
  fixture,
  FnTransport,
  QueueTransport,
} from '../__fixtures__/fake-transport';
import type { ChatDelta, ChatInput } from '../types';
import { AnthropicAdapter } from './anthropic-provider';
import type { BaseProviderHooks } from './base-http-provider';
import { OllamaAdapter } from './ollama-provider';
import { OpenAICompatibleAdapter } from './openai-compatible-provider';
import type { ProviderConfig } from './providers-file';

const input: ChatInput = {
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Say hello.' },
  ],
};

const ANTHROPIC_KEY_ENV = 'TEST_ANTHROPIC_KEY';
const OPENAI_KEY_ENV = 'TEST_OPENAI_KEY';

async function collectStream(iterable: AsyncIterable<ChatDelta>): Promise<ChatDelta[]> {
  const out: ChatDelta[] = [];
  for await (const delta of iterable) {
    out.push(delta);
  }
  return out;
}

beforeEach(() => {
  process.env[ANTHROPIC_KEY_ENV] = 'sk-ant-api03-EXAMPLEKEY1234567890abcdEXAMPLE';
  process.env[OPENAI_KEY_ENV] = 'sk-proj-EXAMPLEKEY1234567890abcdefEXAMPLE';
});

afterEach(() => {
  delete process.env[ANTHROPIC_KEY_ENV];
  delete process.env[OPENAI_KEY_ENV];
  vi.useRealTimers();
});

function anthropicCfg(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'anthropic',
    apiKeyEnv: ANTHROPIC_KEY_ENV,
    model: 'test-anthropic-model',
    ...extra,
  };
}

function openaiCfg(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    apiKeyEnv: OPENAI_KEY_ENV,
    model: 'test-openai-model',
    ...extra,
  };
}

function ollamaCfg(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { type: 'ollama', model: 'test-ollama-model', ...extra };
}

const hooks: BaseProviderHooks = deterministicHooks;

describe('AnthropicAdapter', () => {
  it('chat() parses content, usage and finishReason', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = new AnthropicAdapter({
      name: 'anthropic',
      cfg: anthropicCfg(),
      transport,
      hooks,
    });
    const output = await adapter.chat(input);
    expect(output.content).toBe('Hello from the model.');
    expect(output.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(output.finishReason).toBe('stop');
    expect(output.model).toBe('test-anthropic-model');
    expect(output.costCents).toBeNull();
  });

  it('chat() sends the right URL, headers, system split and body', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('anthropic.chat.json') })]);
    const adapter = new AnthropicAdapter({
      name: 'anthropic',
      cfg: anthropicCfg(),
      transport,
      hooks,
    });
    await adapter.chat({ ...input, maxTokens: 256, temperature: 0.3 });
    const sent = transport.requests[0]?.request;
    expect(sent?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent?.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent?.headers['x-api-key']).toContain('sk-ant-api03');
    const body = JSON.parse(sent?.body ?? '{}');
    expect(body.system).toBe('You are a helpful assistant.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Say hello.' }]);
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.3);
    expect(body.stream).toBe(false);
  });

  it('stream() concatenation equals chat() content and ends with a terminal delta', async () => {
    const chatTransport = new QueueTransport([
      fakeResponse({ body: fixture('anthropic.chat.json') }),
    ]);
    const streamTransport = new QueueTransport([
      fakeResponse({ body: fixture('anthropic.stream.sse.txt') }),
    ]);
    const chatAdapter = new AnthropicAdapter({
      name: 'a',
      cfg: anthropicCfg(),
      transport: chatTransport,
      hooks,
    });
    const streamAdapter = new AnthropicAdapter({
      name: 'a',
      cfg: anthropicCfg(),
      transport: streamTransport,
      hooks,
    });
    const chatOutput = await chatAdapter.chat(input);
    const deltas = await collectStream(streamAdapter.stream(input));
    expect(deltas[deltas.length - 1]).toEqual({ content: '', done: true });
    expect(deltas.map((delta) => delta.content).join('')).toBe(chatOutput.content);
  });

  it('maps stop_reason "max_tokens" to finishReason "length"', async () => {
    const body = JSON.stringify({
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const transport = new QueueTransport([fakeResponse({ body })]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    expect((await adapter.chat(input)).finishReason).toBe('length');
  });

  it('throws ConfigValidationError when the API key env var is unset', () => {
    delete process.env[ANTHROPIC_KEY_ENV];
    const transport = new QueueTransport([fakeResponse({ body: '{}' })]);
    expect(
      () => new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks }),
    ).toThrow(ConfigValidationError);
  });
});

describe('OpenAICompatibleAdapter', () => {
  it('chat() parses content, usage and finishReason', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'qwen',
      cfg: openaiCfg(),
      transport,
      hooks,
    });
    const output = await adapter.chat(input);
    expect(output.content).toBe('Hello from the OpenAI-compatible model.');
    expect(output.usage).toEqual({ inputTokens: 31, outputTokens: 9 });
    expect(output.finishReason).toBe('stop');
  });

  it('does not double-append /v1 when baseUrl already ends in it', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'qwen',
      cfg: openaiCfg(),
      transport,
      hooks,
    });
    await adapter.chat(input);
    expect(transport.requests[0]?.request.url).toBe('https://api.example.test/v1/chat/completions');
  });

  it('appends /v1 when baseUrl omits it and sets the bearer + org headers', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'qwen',
      cfg: openaiCfg({ baseUrl: 'https://api.example.test', organization: 'org-123' }),
      transport,
      hooks,
    });
    await adapter.chat(input);
    const sent = transport.requests[0]?.request;
    expect(sent?.url).toBe('https://api.example.test/v1/chat/completions');
    expect(sent?.headers['authorization']).toContain('Bearer sk-proj-');
    expect(sent?.headers['openai-organization']).toBe('org-123');
  });

  it('runs keyless (no apiKeyEnv) and sends NO authorization header — self-hosted/own-infra', async () => {
    // A self-hosted endpoint (vLLM/TGI/internal Qwen gateway) needing no auth
    // omits apiKeyEnv: the adapter must construct (requiresApiKey=false) and send
    // no `Authorization` header (some endpoints reject an empty `Bearer `).
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'self-hosted',
      cfg: { type: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', model: 'qwen-local' },
      transport,
      hooks,
    });
    const output = await adapter.chat(input);
    expect(output.content.length).toBeGreaterThan(0);
    const sent = transport.requests[0]?.request;
    expect(sent?.url).toBe('http://localhost:8000/v1/chat/completions');
    expect(sent?.headers['authorization']).toBeUndefined();
    expect(sent?.headers['content-type']).toBe('application/json');
  });

  it('merges `extraBody` into the request body (reasoning-off knob for the fast role)', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'fast',
      cfg: openaiCfg({ extraBody: { reasoning_effort: 'none' } }),
      transport,
      hooks,
    });
    await adapter.chat({ ...input, maxTokens: 24 });
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.reasoning_effort).toBe('none'); // the pinned knob is sent
    expect(body.model).toBe('test-openai-model'); // core fields survive the merge
    expect(body.max_tokens).toBe(24);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('never lets `extraBody` clobber core fields (model/messages/stream)', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'fast',
      // A hostile extraBody trying to override core fields must NOT win.
      cfg: openaiCfg({
        extraBody: { model: 'evil', stream: true, thinking: { type: 'disabled' } },
      }),
      transport,
      hooks,
    });
    await adapter.chat(input);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(body.model).toBe('test-openai-model'); // core wins
    expect(body.stream).toBe(false); // chat() is non-streaming
    expect(body.thinking).toEqual({ type: 'disabled' }); // additive key survives
  });

  it('sends reasoning_effort when requested, overriding a reasoning-off extraBody (P1.14)', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'reasoner',
      cfg: openaiCfg({ extraBody: { reasoning_effort: 'none' } }),
      transport,
      hooks,
    });
    await adapter.chat({ ...input, reasoningEffort: 'high' });
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    // An explicit request value wins over the pinned reasoning-off knob.
    expect(body.reasoning_effort).toBe('high');
  });

  it('omits reasoning_effort when not requested', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({ name: 'q', cfg: openaiCfg(), transport, hooks });
    await adapter.chat(input);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect('reasoning_effort' in body).toBe(false);
  });

  it('suppresses reasoning_effort when the provider declares reasoning:false (P1.14)', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'non-reasoner',
      cfg: openaiCfg({ capabilities: { reasoning: false } }),
      transport,
      hooks,
    });
    await adapter.chat({ ...input, reasoningEffort: 'high' });
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    // A non-reasoning backend would 400 on reasoning_effort — it must be omitted.
    expect('reasoning_effort' in body).toBe(false);
  });

  it('maps message images to the OpenAI multimodal content array (vision, P1.14)', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({ name: 'q', cfg: openaiCfg(), transport, hooks });
    await adapter.chat({
      ...input,
      messages: [
        {
          role: 'user',
          content: 'What is in this image?',
          images: [{ url: 'https://example.test/a.png' }, { url: 'data:image/png;base64,iVBOR' }],
        },
      ],
    });
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    const parts = body.messages[0].content;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toEqual({ type: 'text', text: 'What is in this image?' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.test/a.png' },
    });
    expect(parts[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBOR' },
    });
  });

  it('keeps content a plain string when a message has no images', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('openai.chat.json') })]);
    const adapter = new OpenAICompatibleAdapter({ name: 'q', cfg: openaiCfg(), transport, hooks });
    await adapter.chat(input);
    const body = JSON.parse(transport.requests[0]?.request.body ?? '{}');
    expect(typeof body.messages[0].content).toBe('string');
  });

  it('stream() concatenation equals content, parses [DONE] and the final usage chunk', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('openai.stream.sse.txt') }),
    ]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'qwen',
      cfg: openaiCfg(),
      transport,
      hooks,
    });
    const deltas = await collectStream(adapter.stream(input));
    expect(deltas[deltas.length - 1]).toEqual({ content: '', done: true });
    expect(deltas.map((delta) => delta.content).join('')).toBe(
      'Hello from the OpenAI-compatible model.',
    );
  });

  it('throws ConfigValidationError when baseUrl is missing', () => {
    const transport = new QueueTransport([fakeResponse({ body: '{}' })]);
    expect(
      () =>
        new OpenAICompatibleAdapter({
          name: 'qwen',
          cfg: { type: 'openai-compatible', apiKeyEnv: OPENAI_KEY_ENV, model: 'm' },
          transport,
          hooks,
        }),
    ).toThrow(ConfigValidationError);
  });
});

describe('OllamaAdapter', () => {
  it('chat() needs no key and parses content/usage/finishReason', async () => {
    const transport = new QueueTransport([fakeResponse({ body: fixture('ollama.chat.json') })]);
    const adapter = new OllamaAdapter({ name: 'ollama', cfg: ollamaCfg(), transport, hooks });
    const output = await adapter.chat(input);
    expect(output.content).toBe('Hello from the local Ollama model.');
    expect(output.usage).toEqual({ inputTokens: 18, outputTokens: 8 });
    expect(output.finishReason).toBe('stop');
    expect(transport.requests[0]?.request.url).toBe('http://localhost:11434/api/chat');
  });

  it('stream() (ndjson) concatenation equals content and terminates on done:true', async () => {
    const transport = new QueueTransport([
      fakeResponse({ body: fixture('ollama.stream.ndjson.txt') }),
    ]);
    const adapter = new OllamaAdapter({ name: 'ollama', cfg: ollamaCfg(), transport, hooks });
    const deltas = await collectStream(adapter.stream(input));
    expect(deltas[deltas.length - 1]).toEqual({ content: '', done: true });
    expect(deltas.map((delta) => delta.content).join('')).toBe(
      'Hello from the local Ollama model.',
    );
  });

  it('falls back to token estimation when the response omits usage', async () => {
    const body = JSON.stringify({ message: { content: 'hi there' }, done: true });
    const transport = new QueueTransport([fakeResponse({ body })]);
    const adapter = new OllamaAdapter({ name: 'ollama', cfg: ollamaCfg(), transport, hooks });
    const output = await adapter.chat(input);
    expect(output.usage.inputTokens).toBeGreaterThan(0);
    expect(output.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe('retry behavior (shared base)', () => {
  it('retries a 429 then succeeds', async () => {
    const transport = new QueueTransport([
      fakeResponse({ status: 429, body: fixture('anthropic.429.json') }),
      fakeResponse({ body: fixture('anthropic.chat.json') }),
    ]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    const output = await adapter.chat(input);
    expect(output.content).toBe('Hello from the model.');
    expect(transport.sendCount).toBe(2);
  });

  it('honors Retry-After as a floor, adding jitter within the cap', async () => {
    const sleeps: number[] = [];
    const recordingHooks: BaseProviderHooks = {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.9,
    };
    const transport = new QueueTransport([
      fakeResponse({ status: 429, headers: { 'retry-after': '2' }, body: '{}' }),
      fakeResponse({ body: fixture('anthropic.chat.json') }),
    ]);
    const adapter = new AnthropicAdapter({
      name: 'a',
      cfg: anthropicCfg(),
      transport,
      hooks: recordingHooks,
    });
    await adapter.chat(input);
    // Server asked for 2s; we never wait LESS than that, and add jitter in the
    // headroom up to the 8s cap so concurrent clients don't retry in lockstep.
    // floor 2000 + 0.9 * (8000 - 2000) = 7400.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(sleeps[0]).toBe(7400);
  });

  it('throws after maxRetries on repeated 500s', async () => {
    const transport = new QueueTransport([fakeResponse({ status: 500, body: 'boom' })]);
    const adapter = new AnthropicAdapter({
      name: 'a',
      cfg: anthropicCfg({ maxRetries: 2 }),
      transport,
      hooks,
    });
    await expect(adapter.chat(input)).rejects.toMatchObject({ code: 'server_error' });
    // 1 initial + 2 retries.
    expect(transport.sendCount).toBe(3);
  });

  it('does NOT retry a 400', async () => {
    const transport = new QueueTransport([fakeResponse({ status: 400, body: 'bad' })]);
    const adapter = new AnthropicAdapter({ name: 'a', cfg: anthropicCfg(), transport, hooks });
    await expect(adapter.chat(input)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(transport.sendCount).toBe(1);
  });

  it('retries the initial stream connect but never mid-stream', async () => {
    const transport = new QueueTransport([
      fakeResponse({ status: 503, body: 'unavailable' }),
      fakeResponse({ body: fixture('openai.stream.sse.txt') }),
    ]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'qwen',
      cfg: openaiCfg(),
      transport,
      hooks,
    });
    const deltas = await collectStream(adapter.stream(input));
    expect(deltas.map((delta) => delta.content).join('')).toBe(
      'Hello from the OpenAI-compatible model.',
    );
    expect(transport.sendCount).toBe(2);
  });

  it('a mid-stream transport failure is NOT retried (no replay)', async () => {
    const transport = new FnTransport(async () => ({
      status: 200,
      ok: true,
      headers: {},
      async text() {
        return '';
      },
      lines() {
        return (async function* fail(): AsyncIterable<string> {
          yield 'data: {"choices":[{"delta":{"content":"partial "}}]}';
          yield '';
          throw new Error('connection dropped mid-stream');
        })();
      },
    }));
    const adapter = new OpenAICompatibleAdapter({
      name: 'qwen',
      cfg: openaiCfg(),
      transport,
      hooks,
    });
    await expect(collectStream(adapter.stream(input))).rejects.toThrow(
      'connection dropped mid-stream',
    );
    // Only the initial connect happened; no replay attempt.
    expect(transport.sendCount).toBe(1);
  });
});

describe('error mapping (shared base)', () => {
  it.each([
    [401, 'auth_failed'],
    [404, 'model_not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
  ])('HTTP %s → ProviderError code %s', async (status, code) => {
    const transport = new QueueTransport([fakeResponse({ status, body: 'err' })]);
    const adapter = new OllamaAdapter({
      name: 'ollama',
      cfg: ollamaCfg({ maxRetries: 0 }),
      transport,
      hooks,
    });
    await expect(adapter.chat(input)).rejects.toMatchObject({ code });
  });
});

describe('redaction', () => {
  it('never leaks an echoed API key into ProviderError details', async () => {
    const transport = new QueueTransport([
      fakeResponse({ status: 401, body: fixture('openai.401.json') }),
    ]);
    const adapter = new OpenAICompatibleAdapter({
      name: 'qwen',
      cfg: openaiCfg({ maxRetries: 0 }),
      transport,
      hooks,
    });
    let caught: unknown;
    try {
      await adapter.chat(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const serialized = JSON.stringify((caught as ProviderError).details);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('sk-proj-EXAMPLEKEY1234567890abcdefEXAMPLE');
  });
});

describe('timeout and abort', () => {
  it('maps a timeout to ProviderError code "timeout"', async () => {
    vi.useFakeTimers();
    // Transport that never resolves until aborted.
    const transport = new FnTransport(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const adapter = new AnthropicAdapter({
      name: 'a',
      cfg: anthropicCfg({ timeoutMs: 50, maxRetries: 0 }),
      transport,
      hooks,
    });
    const promise = adapter.chat(input);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('propagates a caller abort signal as a typed ProviderError', async () => {
    const controller = new AbortController();
    const transport = new FnTransport(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const adapter = new AnthropicAdapter({
      name: 'a',
      cfg: anthropicCfg({ maxRetries: 0 }),
      transport,
      hooks,
    });
    const promise = adapter.chat({ ...input, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(ProviderError);
  });

  it('maps a timeout during the stream connect phase to code "timeout"', async () => {
    vi.useFakeTimers();
    // Connect never resolves until the timeout aborts it — exercises the
    // connect path's guaranteed timer/listener cleanup (finally).
    const transport = new FnTransport(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const adapter = new OpenAICompatibleAdapter({
      name: 'qwen',
      cfg: openaiCfg({ timeoutMs: 50, maxRetries: 0 }),
      transport,
      hooks,
    });
    const promise = collectStream(adapter.stream(input));
    const assertion = expect(promise).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });
});
