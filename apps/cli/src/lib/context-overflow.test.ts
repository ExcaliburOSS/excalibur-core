import { describe, expect, it } from 'vitest';
import { isContextOverflowError } from './context-overflow';

describe('isContextOverflowError', () => {
  it('detects common provider overflow phrasings', () => {
    const samples = [
      "This model's maximum context length is 128000 tokens, however you requested 140000.",
      'prompt is too long: 210000 tokens > 200000 maximum',
      new Error('context_length_exceeded'),
      'Please reduce the length of the messages.',
      { error: { message: 'input is too long for this model', code: 'context_window' } },
      { cause: new Error('too many input tokens') },
    ];
    for (const s of samples) {
      expect(isContextOverflowError(s), JSON.stringify(s)).toBe(true);
    }
  });

  it('does NOT fire on unrelated errors', () => {
    const samples = [
      new Error('ECONNRESET'),
      'Internal Server Error (500)',
      'rate limit exceeded — slow down',
      { message: 'invalid api key' },
      undefined,
      null,
    ];
    for (const s of samples) {
      expect(isContextOverflowError(s), JSON.stringify(s)).toBe(false);
    }
  });
});
