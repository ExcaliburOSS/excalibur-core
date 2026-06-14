import { describe, expect, it } from 'vitest';
import { renderWelcome, type WelcomeContext } from './welcome';

const base: WelcomeContext = {
  version: '0.1.0',
  name: 'Rafael',
  model: 'mock',
  org: 'ExcaliburOSS',
  user: 'rafael@calliope.so',
  tip: 'Describe what you want in plain words — Excalibur routes it to ask, run, patch or discovery.',
  whatsNew: 'Real model gateway, repo-aware context, and live streaming.',
  width: 80,
  unicode: true,
};

/** Visible width with ANSI stripped (the glyphs we use are width-1). */
function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '').length;
}

describe('renderWelcome', () => {
  it('renders a perfectly rectangular frame at several widths and modes', () => {
    for (const cfg of [
      { width: 80, unicode: true },
      { width: 72, unicode: true },
      { width: 64, unicode: false },
      { width: 50, unicode: true }, // collapses to a single column
    ]) {
      const out = renderWelcome({ ...base, ...cfg });
      const widths = new Set(out.split('\n').map((line) => vlen(line)));
      expect(widths.size, `uniform width @ ${cfg.width}/${cfg.unicode}`).toBe(1);
    }
  });

  it('includes the title, greeting, identity and the two right-column sections', () => {
    const out = renderWelcome(base);
    expect(out).toContain('EXCALIBUR');
    expect(out).toContain('v0.1.0');
    expect(out).toContain('Welcome back, Rafael');
    expect(out).toContain('mock');
    expect(out).toContain('ExcaliburOSS');
    expect(out).toContain('rafael@calliope.so');
    expect(out).toContain('Tip');
    expect(out).toContain('new');
  });

  it('handles an empty name and a garbage width without crashing', () => {
    const out = renderWelcome({ ...base, name: '', width: 0 });
    expect(out).toContain('Welcome back, there');
    expect(new Set(out.split('\n').map((line) => vlen(line))).size).toBe(1);
  });

  it('hides org/user rows when empty', () => {
    const out = renderWelcome({ ...base, org: '', user: '' });
    expect(out).not.toContain('ExcaliburOSS');
    expect(out).not.toContain('rafael@calliope.so');
    expect(out).toContain('Welcome back, Rafael');
  });

  it('falls back to pure ASCII (no box-drawing/block glyphs) when unicode is off', () => {
    const out = renderWelcome({ ...base, unicode: false });
    expect(out).not.toMatch(/[╭╮╰╯│─▟▜█╪▓▒░╾╼]/);
    expect(out).toContain('+');
  });
});
