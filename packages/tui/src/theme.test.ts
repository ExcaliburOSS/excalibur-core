import { describe, expect, it } from 'vitest';
import {
  THEME_NAMES,
  daltonizedDark,
  daltonizedLight,
  darkColors,
  highContrastDark,
  lightColors,
  paletteFor,
  type Palette,
} from './theme';

const ALL: Palette[] = [darkColors, lightColors, daltonizedDark, daltonizedLight, highContrastDark];

describe('theme presets', () => {
  it('every preset defines all palette tokens (incl. the diff tints)', () => {
    const keys: (keyof Palette)[] = [
      'accent',
      'accentDim',
      'success',
      'warn',
      'danger',
      'text',
      'muted',
      'rail',
      'diffAddFg',
      'diffDelFg',
      'diffAddBg',
      'diffDelBg',
      'diffAddWordBg',
      'diffDelWordBg',
    ];
    for (const palette of ALL) {
      for (const key of keys) {
        expect(palette[key], `${key} on ${palette.mode}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('paletteFor resolves names (auto follows mode; presets pick a variant)', () => {
    expect(paletteFor('dark', 'dark')).toBe(darkColors);
    expect(paletteFor('light', 'dark')).toBe(lightColors);
    expect(paletteFor('auto', 'light')).toBe(lightColors);
    expect(paletteFor('auto', 'dark')).toBe(darkColors);
    expect(paletteFor('daltonized', 'dark')).toBe(daltonizedDark);
    expect(paletteFor('daltonized', 'light')).toBe(daltonizedLight);
    expect(paletteFor('high-contrast', 'dark')).toBe(highContrastDark);
  });

  it('daltonized avoids the red/green collision: add vs del are blue vs amber', () => {
    // Added "good" colour is blue-dominant (b ≥ r); removed "bad" is amber (r ≥ b).
    const blue = parseInt(daltonizedDark.diffAddFg.slice(5, 7), 16); // B channel of add fg
    const blueR = parseInt(daltonizedDark.diffAddFg.slice(1, 3), 16); // R channel of add fg
    expect(blue).toBeGreaterThan(blueR);
    const amberR = parseInt(daltonizedDark.diffDelFg.slice(1, 3), 16); // R channel of del fg
    const amberB = parseInt(daltonizedDark.diffDelFg.slice(5, 7), 16); // B channel of del fg
    expect(amberR).toBeGreaterThan(amberB);
  });

  it('THEME_NAMES lists every selectable name', () => {
    expect(THEME_NAMES).toEqual(['auto', 'dark', 'light', 'daltonized', 'high-contrast']);
  });
});
