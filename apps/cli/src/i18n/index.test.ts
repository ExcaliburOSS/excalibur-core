import { describe, expect, it } from 'vitest';
import { detectCliLocale } from './index';

/**
 * Locale resolution precedence + the TTY gate on OS auto-detection.
 *
 * An explicit env/config source always wins. When the environment is neutral
 * (`C`/`POSIX`/unset), the OS preferred language is consulted ONLY for an
 * interactive terminal — under vitest `process.stdout.isTTY` is falsy, so these
 * cases stay on the deterministic `en` default (the invariant that keeps the
 * English-asserting suite reproducible regardless of the host machine's region).
 */
describe('detectCliLocale', () => {
  it('honours an explicit EXCALIBUR_LANG above everything', () => {
    expect(detectCliLocale({ EXCALIBUR_LANG: 'es', LANG: 'en_US.UTF-8' })).toBe('es');
    expect(detectCliLocale({ EXCALIBUR_LANG: 'en_GB', LANG: 'es_ES.UTF-8' })).toBe('en');
  });

  it('honours the repo config language over LANG', () => {
    expect(detectCliLocale({ LANG: 'en_US.UTF-8' }, 'es')).toBe('es');
  });

  it('reads LC_ALL / LC_MESSAGES / LANG in order', () => {
    expect(detectCliLocale({ LANG: 'es_ES.UTF-8' })).toBe('es');
    expect(detectCliLocale({ LANG: 'en_US.UTF-8' })).toBe('en');
    expect(detectCliLocale({ LC_ALL: 'es_ES.UTF-8', LANG: 'en_US.UTF-8' })).toBe('es');
  });

  it('stays on the deterministic `en` default for a neutral env in a non-TTY run', () => {
    // `C`/`POSIX`/unset are neither es nor en; the OS fallback is gated to a TTY,
    // so a scripted/piped/CI/test run must NOT switch language by host region.
    expect(detectCliLocale({ LANG: 'C.UTF-8' })).toBe('en');
    expect(detectCliLocale({ LANG: 'POSIX' })).toBe('en');
    expect(detectCliLocale({})).toBe('en');
  });

  it('ignores a recognised-but-unsupported locale and keeps scanning', () => {
    // `fr` is unsupported → fall through to the supported LANG rather than force en.
    expect(detectCliLocale({ LC_ALL: 'fr_FR.UTF-8', LANG: 'es_ES.UTF-8' })).toBe('es');
  });
});
