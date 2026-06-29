import { describe, expect, it } from 'vitest';
import { stripReasoning } from './reasoning';

describe('stripReasoning (RUN-FIX-22)', () => {
  it('removes a complete <antThinking> block', () => {
    expect(
      stripReasoning('Voy a empezar.<antThinking>Need to run npm test first.</antThinking>'),
    ).toBe('Voy a empezar.');
  });

  it('removes <thinking>/<think>/<reasoning> variants (case-insensitive)', () => {
    expect(stripReasoning('a<thinking>x</thinking>b')).toBe('ab');
    expect(stripReasoning('a<THINK>x</THINK>b')).toBe('ab');
    expect(stripReasoning('a<reasoning>x</reasoning>b')).toBe('ab');
  });

  it('drops a DANGLING unclosed block (streaming: close not arrived yet)', () => {
    // Trailing whitespace before the cut is dropped — the visible prose has no dangling
    // space while the model "thinks"; the space returns when real prose follows the block.
    expect(stripReasoning('Hello there. <antThinking>Need to run npm test and inspect')).toBe(
      'Hello there.',
    );
  });

  it('keeps interleaving whitespace when a COMPLETE block sits mid-prose', () => {
    expect(stripReasoning('Hello there. <antThinking>x</antThinking>Now I run it.')).toBe(
      'Hello there. Now I run it.',
    );
  });

  it('drops a partial opening tag arriving char-by-char', () => {
    expect(stripReasoning('Hello. <antTh')).toBe('Hello.');
    expect(stripReasoning('Hello. <re')).toBe('Hello.');
  });

  it('strips a leading stray status glyph / emoji run', () => {
    expect(stripReasoning('✗ I will run the tests 🛠')).toBe('I will run the tests 🛠');
    expect(stripReasoning('  ❌  comenzando')).toBe('comenzando');
  });

  it('reproduces the exact leaked line the user saw', () => {
    const leaked =
      '✗ I will start by running the tests and inspecting the current state of the project. 🛠\n<antThinking>\nNeed to run npm test and inspect files to see root cause.\n</antThinking>';
    expect(stripReasoning(leaked)).toBe(
      'I will start by running the tests and inspecting the current state of the project. 🛠',
    );
  });

  it('NEVER clips ordinary prose containing < (comparisons, generics)', () => {
    expect(stripReasoning('if a < b then Array<T> is fine')).toBe('if a < b then Array<T> is fine');
    expect(stripReasoning('the result is x < y')).toBe('the result is x < y');
  });

  it('is a no-op on empty / clean text', () => {
    expect(stripReasoning('')).toBe('');
    expect(stripReasoning('just normal prose')).toBe('just normal prose');
  });
});
