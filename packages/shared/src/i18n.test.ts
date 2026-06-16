import { describe, expect, it } from 'vitest';
import { detectLocale, isLocale, makeTranslator, type Catalog, type Locale } from './i18n';

describe('detectLocale', () => {
  it('honors EXCALIBUR_LANG above everything', () => {
    expect(detectLocale({ env: { EXCALIBUR_LANG: 'es', LANG: 'en_US.UTF-8' }, configLanguage: 'en' })).toBe('es');
  });

  it('falls to the explicit config language when no EXCALIBUR_LANG', () => {
    expect(detectLocale({ env: { LANG: 'en_US.UTF-8' }, configLanguage: 'es' })).toBe('es');
  });

  it('reads LC_ALL / LC_MESSAGES / LANG (in that order) when no override', () => {
    expect(detectLocale({ env: { LANG: 'es_ES.UTF-8' } })).toBe('es');
    expect(detectLocale({ env: { LC_MESSAGES: 'es_AR', LANG: 'en_US' } })).toBe('es');
    expect(detectLocale({ env: { LC_ALL: 'en_GB', LANG: 'es_ES' } })).toBe('en');
  });

  it('defaults to en (incl. C/POSIX and unsupported locales)', () => {
    expect(detectLocale({})).toBe('en');
    expect(detectLocale({ env: { LANG: 'C' } })).toBe('en');
    expect(detectLocale({ env: { LANG: 'fr_FR.UTF-8' } })).toBe('en'); // unsupported → default
  });

  it('skips an unsupported higher-precedence source and reads the next', () => {
    // config says fr (unsupported) → keep scanning → LANG=es wins.
    expect(detectLocale({ env: { LANG: 'es_ES.UTF-8' }, configLanguage: 'fr' })).toBe('es');
  });
});

describe('isLocale', () => {
  it('narrows en/es and rejects others', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('es')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('makeTranslator', () => {
  const catalogs: Partial<Record<Locale, Catalog>> = {
    en: { greeting: 'Hello, {name}!', bare: 'Plain', onlyEn: 'English only' },
    es: { greeting: '¡Hola, {name}!', bare: 'Llano' },
  };

  it('resolves + interpolates in the active locale', () => {
    const t = makeTranslator(catalogs, 'es');
    expect(t('greeting', { name: 'Rafa' })).toBe('¡Hola, Rafa!');
    expect(t('bare')).toBe('Llano');
  });

  it('falls back to en for a key missing in es', () => {
    const t = makeTranslator(catalogs, 'es');
    expect(t('onlyEn')).toBe('English only');
  });

  it('returns the key itself when missing everywhere (dev-visible)', () => {
    const t = makeTranslator(catalogs, 'en');
    expect(t('nope.missing')).toBe('nope.missing');
  });

  it('leaves an unprovided placeholder visible as {var}', () => {
    const t = makeTranslator(catalogs, 'en');
    expect(t('greeting')).toBe('Hello, {name}!');
  });

  it('coerces numeric vars to strings', () => {
    const t = makeTranslator({ en: { n: 'count={c}' } }, 'en');
    expect(t('n', { c: 3 })).toBe('count=3');
  });
});
