import { describe, expect, it, vi } from 'vitest';
import {
  askStructured,
  extractJsonValue,
  extractJsonValues,
  validateAgainstSchema,
  type JsonSchema,
} from './structured-output';

describe('extractJsonValue', () => {
  it('parses clean JSON, fenced JSON, and JSON embedded in prose', () => {
    expect(extractJsonValue('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonValue('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonValue('Here you go:\n{"a":1}\nThanks')).toEqual({ a: 1 });
    expect(extractJsonValue('[1,2,3]')).toEqual([1, 2, 3]);
    expect(extractJsonValue('not json at all')).toBeUndefined();
  });

  it('handles MULTIPLE objects, a leading example, and JSON OUTSIDE a fence (review fixes)', () => {
    // greedy first-{..last-} used to engulf both → undefined; now returns the first.
    expect(extractJsonValue('Result: {"a":1}. Alt: {"b":2}')).toEqual({ a: 1 });
    expect(extractJsonValue('Example: {} \n Answer: {"a":1}')).toEqual({});
    // a non-JSON fenced block then the real JSON outside the fence.
    expect(extractJsonValue('```\nthinking...\n```\n{"a":1}')).toEqual({ a: 1 });
    // braces inside strings never break the scan.
    expect(extractJsonValue('{"a":"}"}')).toEqual({ a: '}' });
  });

  it('extractJsonValues returns EVERY embedded JSON value in order', () => {
    expect(extractJsonValues('a {"x":1} b [2,3] c {"y":4}')).toEqual([{ x: 1 }, [2, 3], { y: 4 }]);
  });
});

describe('validateAgainstSchema', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['name', 'priority'],
    properties: {
      name: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'high'] },
      tags: { type: 'array', items: { type: 'string' } },
      count: { type: 'integer' },
    },
  };

  it('accepts a conforming object', () => {
    expect(
      validateAgainstSchema({ name: 'x', priority: 'high', tags: ['a'], count: 2 }, schema),
    ).toEqual([]);
  });

  it('reports missing required, wrong types, bad enum, and bad array items', () => {
    const errs = validateAgainstSchema({ priority: 'urgent', tags: [1], count: 1.5 }, schema);
    expect(errs.some((e) => e.includes('.name') && e.includes('required'))).toBe(true);
    expect(errs.some((e) => e.includes('.priority') && e.includes('enum'))).toBe(true);
    expect(errs.some((e) => e.includes('.tags[0]') && e.includes('string'))).toBe(true);
    expect(errs.some((e) => e.includes('.count') && e.includes('integer'))).toBe(true);
  });

  it('flags a top-level type mismatch', () => {
    expect(validateAgainstSchema('hello', { type: 'object' })).toEqual(['$: expected object']);
  });

  it('validates required/properties even when the schema OMITS `type` (review fix)', () => {
    const typeless: JsonSchema = { required: ['name'], properties: { name: { type: 'string' } } };
    expect(validateAgainstSchema({ name: 'ok' }, typeless)).toEqual([]);
    expect(
      validateAgainstSchema({}, typeless).some((e) => e.includes('name') && e.includes('required')),
    ).toBe(true);
  });

  it('compares object/array enum members structurally, not by reference (review fix)', () => {
    const s: JsonSchema = { enum: [{ k: 1 }, 'x'] };
    expect(validateAgainstSchema({ k: 1 }, s)).toEqual([]); // structurally equal → valid
    expect(validateAgainstSchema('x', s)).toEqual([]);
    expect(validateAgainstSchema({ k: 2 }, s).length).toBeGreaterThan(0);
  });
});

describe('askStructured', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };

  it('returns the parsed value on a first conforming response (no retry)', async () => {
    const chat = vi.fn(async () => ({ content: '{"answer":"42"}' }));
    const result = await askStructured({ chat }, { question: 'q', schema });
    expect(result.value).toEqual({ answer: '42' });
    expect(result.errors).toEqual([]);
    expect(result.retried).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('re-prompts ONCE with the errors and succeeds on the corrected response', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ content: 'sorry, here: {"wrong":true}' })
      .mockResolvedValueOnce({ content: '{"answer":"now correct"}' });
    const result = await askStructured({ chat }, { question: 'q', schema });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.retried).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({ answer: 'now correct' });
    // The corrective turn fed back the validation error.
    const secondCall = chat.mock.calls[1]?.[0] as { messages: Array<{ content: string }> };
    expect(secondCall.messages.some((m) => m.content.includes('did not conform'))).toBe(true);
  });

  it('picks the VALIDATING candidate when the model emits an example first', async () => {
    // The model prints a non-conforming example object, then the real answer.
    const chat = vi.fn(async () => ({ content: 'Example: {"foo":1}\nAnswer: {"answer":"real"}' }));
    const result = await askStructured({ chat }, { question: 'q', schema });
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({ answer: 'real' });
    expect(chat).toHaveBeenCalledTimes(1); // no retry needed — it found the valid one
  });

  it('surfaces residual errors when even the retry does not conform', async () => {
    const chat = vi.fn(async () => ({ content: '{"nope":1}' }));
    const result = await askStructured({ chat }, { question: 'q', schema });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
