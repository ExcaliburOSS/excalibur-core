import { describe, expect, it } from 'vitest';
import {
  detectColorTier,
  fgSequence,
  hexToRgb,
  paint,
  rgbToAnsi16,
  rgbToAnsi256,
  stripAnsi,
  type ColorTier,
} from './color.js';

describe('hexToRgb', () => {
  it('parses #rrggbb and bare rrggbb', () => {
    expect(hexToRgb('#5BC8FF')).toEqual({ r: 0x5b, g: 0xc8, b: 0xff });
    expect(hexToRgb('0969DA')).toEqual({ r: 0x09, g: 0x69, b: 0xda });
  });
  it('rejects malformed input', () => {
    expect(hexToRgb('#fff')).toBeNull();
    expect(hexToRgb('nothex')).toBeNull();
  });
});

describe('detectColorTier', () => {
  it('NO_COLOR forces off, even on a truecolor TTY', () => {
    expect(detectColorTier({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe('none');
  });
  it('FORCE_COLOR / EXCALIBUR_FORCE_COLOR pin a level regardless of TTY', () => {
    expect(detectColorTier({ FORCE_COLOR: '3' }, false)).toBe('truecolor');
    expect(detectColorTier({ FORCE_COLOR: '2' }, false)).toBe('ansi256');
    expect(detectColorTier({ FORCE_COLOR: '1' }, false)).toBe('ansi16');
    expect(detectColorTier({ FORCE_COLOR: '0' }, true)).toBe('none');
    expect(detectColorTier({ EXCALIBUR_FORCE_COLOR: '2' }, false)).toBe('ansi256');
  });
  it('a non-TTY with no force is none; TERM=dumb is none', () => {
    expect(detectColorTier({ COLORTERM: 'truecolor' }, false)).toBe('none');
    expect(detectColorTier({ TERM: 'dumb' }, true)).toBe('none');
  });
  it('sniffs COLORTERM and TERM on a TTY', () => {
    expect(detectColorTier({ COLORTERM: '24bit', TERM: 'xterm' }, true)).toBe('truecolor');
    expect(detectColorTier({ TERM: 'xterm-256color' }, true)).toBe('ansi256');
    expect(detectColorTier({ TERM: 'xterm' }, true)).toBe('ansi16');
  });
});

describe('downsampling', () => {
  it('maps pure colours onto sensible 256 cube indices', () => {
    expect(rgbToAnsi256({ r: 0, g: 0, b: 0 })).toBe(16);
    expect(rgbToAnsi256({ r: 255, g: 255, b: 255 })).toBe(231);
    expect(rgbToAnsi256({ r: 255, g: 0, b: 0 })).toBe(196);
  });
  it('greys snap to the 232–255 ramp', () => {
    const idx = rgbToAnsi256({ r: 128, g: 128, b: 128 });
    expect(idx).toBeGreaterThanOrEqual(232);
    expect(idx).toBeLessThanOrEqual(255);
  });
  it('nearest 16-colour picks the matching SGR code', () => {
    expect(rgbToAnsi16({ r: 0, g: 0, b: 0 })).toBe(30);
    expect(rgbToAnsi16({ r: 255, g: 255, b: 255 })).toBe(97);
    expect(rgbToAnsi16({ r: 245, g: 80, b: 80 })).toBe(91); // bright red
  });
});

describe('fgSequence / paint', () => {
  const cases: Array<[ColorTier, string]> = [
    ['truecolor', '\x1b[38;2;91;200;255m'],
    ['ansi256', '\x1b[38;5;'],
    ['ansi16', '\x1b['],
  ];
  it.each(cases)('emits a %s foreground introducer', (tier, prefix) => {
    expect(fgSequence('#5BC8FF', tier).startsWith(prefix)).toBe(true);
  });

  it('tier none and bad hex return the text untouched (byte-identical plain path)', () => {
    expect(paint('hello', '#5BC8FF', 'none')).toBe('hello');
    expect(paint('hello', 'nothex', 'truecolor')).toBe('hello');
  });

  it('paint wraps with an introducer and a reset, recoverable via stripAnsi', () => {
    const painted = paint('OK', '#5AD18A', 'truecolor');
    expect(painted).not.toBe('OK');
    expect(painted.endsWith('\x1b[0m')).toBe(true);
    expect(stripAnsi(painted)).toBe('OK');
  });
});
