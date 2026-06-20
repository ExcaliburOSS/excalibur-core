import { describe, expect, it } from 'vitest';
import type { ChatInput, ChatOutput } from '@excalibur/model-gateway';
import { ExtractError, extractStructured, parseJsonLoose, type GatewayChat } from './extract';

function fakeGateway(reply: string): { gateway: GatewayChat; calls: ChatInput[] } {
  const calls: ChatInput[] = [];
  const gateway: GatewayChat = {
    chat: async (input: ChatInput): Promise<ChatOutput> => {
      calls.push(input);
      return {
        content: reply,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'fake',
        costCents: null,
        finishReason: 'stop',
      } as ChatOutput;
    },
  };
  return { gateway, calls };
}

describe('parseJsonLoose', () => {
  it('parses plain JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips code fences', () => {
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it('recovers JSON embedded in prose', () => {
    expect(parseJsonLoose('Here you go: {"a":3} done')).toEqual({ a: 3 });
  });
  it('throws on non-JSON', () => {
    expect(() => parseJsonLoose('no json here')).toThrow(ExtractError);
  });
});

describe('extractStructured', () => {
  it('runs one constrained model call and returns parsed JSON', async () => {
    const { gateway, calls } = fakeGateway('{"title":"Example Domain"}');
    const result = await extractStructured('https://example.com/', {
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      markdown: '# Example Domain\n\nbody',
      gateway,
      source: 'tier1',
    });
    expect(result.data).toEqual({ title: 'Example Domain' });
    expect(result.source).toBe('tier1');
    expect(calls).toHaveLength(1);
    // The page content + schema must reach the model.
    const user = String(calls[0]?.messages.at(-1)?.content ?? '');
    expect(user).toContain('Example Domain');
    expect(user).toContain('JSON Schema');
  });

  it('marks truncated when the page exceeds the input cap', async () => {
    const { gateway } = fakeGateway('{}');
    const result = await extractStructured('https://x.test/', {
      schema: {},
      markdown: 'x'.repeat(50_000),
      gateway,
      maxInputChars: 100,
    });
    expect(result.truncated).toBe(true);
  });
});
