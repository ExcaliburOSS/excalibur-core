import { describe, expect, it } from 'vitest';
import { shimmerSpans } from './shimmer.js';
import { darkColors } from './theme.js';

describe('shimmerSpans', () => {
  it('returns [] for empty text', () => {
    expect(shimmerSpans('', 0, darkColors, darkColors.muted)).toEqual([]);
  });

  it('preserves the text exactly — only colour changes', () => {
    const text = 'write src/app/components/Header.tsx';
    for (const frame of [0, 3, 7, 12, 40]) {
      const joined = shimmerSpans(text, frame, darkColors, darkColors.muted)
        .map((s) => s.text)
        .join('');
      expect(joined).toBe(text);
    }
  });

  it('lights a crest that travels left → right as the frame advances', () => {
    const text = 'running the test suite';
    const base = darkColors.muted;
    // The crest is the span painted in the bright accent; its char offset = head.
    const crestAt = (frame: number): number => {
      let idx = 0;
      for (const s of shimmerSpans(text, frame, darkColors, base)) {
        if (s.hex.toLowerCase() === darkColors.accentBright.toLowerCase()) return idx;
        idx += s.text.length;
      }
      return -1;
    };
    const early = crestAt(1);
    const later = crestAt(5);
    expect(early).toBeGreaterThanOrEqual(0);
    expect(later).toBeGreaterThan(early);
  });

  it('is deterministic in the frame (no wall-clock)', () => {
    const a = shimmerSpans('hello world', 4, darkColors, darkColors.muted);
    const b = shimmerSpans('hello world', 4, darkColors, darkColors.muted);
    expect(a).toEqual(b);
  });

  it('is code-point aware — never splits a multi-byte glyph', () => {
    const spans = shimmerSpans('✓ done ◆ ✎', 2, darkColors, darkColors.muted);
    expect(spans.map((s) => s.text).join('')).toBe('✓ done ◆ ✎');
  });
});
