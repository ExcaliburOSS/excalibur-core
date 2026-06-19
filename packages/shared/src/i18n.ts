/**
 * i18n engine (plan §"Idioma"): Excalibur's chrome works in at least `en` and
 * `es`, with locale auto-detection. This module owns the LOCALE-AGNOSTIC engine
 * — the `Locale` type, detection, and a catalog-backed `t(key, vars)` — while
 * each package co-locates its OWN message catalogs (the CLI owns CLI copy, core
 * owns report/AGENTS.md copy, …). Keys, not hardcoded strings, are the contract.
 */

/** Supported chrome locales. The architecture is ready for more; en+es is baseline. */
export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

/** True when `value` is a supported {@link Locale}. */
export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'es';
}

/**
 * Resolves the active locale by precedence (plan §"Idioma"):
 * `EXCALIBUR_LANG` > explicit config `language` > `LC_ALL`/`LC_MESSAGES`/`LANG`
 * > `en`. Only `en`/`es` are recognized; anything else is skipped (an unknown
 * `es_AR.UTF-8` still maps to `es`, `C`/`POSIX` fall through to `en`).
 */
export function detectLocale(
  options: {
    env?: NodeJS.ProcessEnv;
    configLanguage?: string | undefined;
  } = {},
): Locale {
  const env = options.env ?? {};
  const candidates = [
    env['EXCALIBUR_LANG'],
    options.configLanguage,
    env['LC_ALL'],
    env['LC_MESSAGES'],
    env['LANG'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      continue;
    }
    const lower = candidate.toLowerCase();
    if (lower.startsWith('es')) {
      return 'es';
    }
    if (lower.startsWith('en')) {
      return 'en';
    }
    // A recognized-but-unsupported locale (e.g. `fr`) keeps scanning lower-
    // precedence sources rather than forcing `en` immediately.
  }
  return 'en';
}

/** A message catalog: key → template with `{var}` placeholders. */
export type Catalog = Record<string, string>;

/** `t(key, vars)` — the interpolated message for the active locale. */
export type Translator = (key: string, vars?: Record<string, string | number>) => string;

/** Interpolates `{var}` placeholders; a missing var is left visible as `{var}`. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars?.[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

/**
 * Builds a {@link Translator} over per-locale catalogs for a fixed `locale`.
 * Resolution: active locale → `en` fallback → the key itself (so a missing key
 * is visible in dev rather than rendering blank). Placeholders are interpolated.
 */
export function makeTranslator(
  catalogs: Partial<Record<Locale, Catalog>>,
  locale: Locale,
): Translator {
  const active = catalogs[locale] ?? {};
  const fallback = catalogs.en ?? {};
  return (key, vars) => {
    const template = active[key] ?? fallback[key] ?? key;
    return interpolate(template, vars);
  };
}
