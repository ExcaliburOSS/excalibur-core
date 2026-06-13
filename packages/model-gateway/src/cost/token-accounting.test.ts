import { describe, expect, it } from 'vitest';
import { estimateTokens } from './cost';
import { normalizeUsage } from './token-accounting';

describe('normalizeUsage', () => {
  it('prefers provider-reported counts', () => {
    const usage = normalizeUsage(
      { inputTokens: 42, outputTokens: 7 },
      { inputText: 'ignored', outputText: 'ignored' },
    );
    expect(usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it('falls back to estimateTokens for a missing count', () => {
    const inputText = 'a'.repeat(40);
    const outputText = 'b'.repeat(20);
    const usage = normalizeUsage(
      { inputTokens: 99 },
      { inputText, outputText },
    );
    expect(usage.inputTokens).toBe(99);
    expect(usage.outputTokens).toBe(estimateTokens(outputText));
  });

  it('estimates both when reported usage is undefined', () => {
    const inputText = 'hello world';
    const outputText = 'a longer model response here';
    const usage = normalizeUsage(undefined, { inputText, outputText });
    expect(usage).toEqual({
      inputTokens: estimateTokens(inputText),
      outputTokens: estimateTokens(outputText),
    });
  });

  it('treats negative or non-finite reported counts as missing', () => {
    const usage = normalizeUsage(
      { inputTokens: -1, outputTokens: Number.NaN },
      { inputText: 'abcd', outputText: 'efgh' },
    );
    expect(usage.inputTokens).toBe(estimateTokens('abcd'));
    expect(usage.outputTokens).toBe(estimateTokens('efgh'));
  });
});
