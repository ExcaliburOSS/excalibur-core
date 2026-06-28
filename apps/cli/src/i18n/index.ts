import {
  detectLocale,
  makeTranslator,
  type Catalog,
  type Locale,
  type Translator,
} from '@excalibur/shared';
import { execFileSync } from 'node:child_process';
import { EN } from './en';
import { ES } from './es';

/**
 * The CLI's message catalogs + translator wiring (plan §"Idioma"). The chrome is
 * keyed, not hardcoded; `EN` is the source-of-truth catalog and `ES` the Spanish
 * translation (falling back to `EN` per key). Locale is auto-detected
 * (EXCALIBUR_LANG > config `language` > LANG/LC_* > OS system language > en).
 * Migration of the remaining literals is incremental — every key added here.
 */
const CATALOGS: Record<Locale, Catalog> = { en: EN, es: ES };

/**
 * The OS's *preferred UI language*, consulted ONLY when the environment is
 * inconclusive — memoised, best-effort, never throws.
 *
 * Why: a Spanish macOS commonly launches a shell with `LANG=C.UTF-8` (or unset),
 * so the env signal is neither `es` nor `en` and the chrome wrongly fell back to
 * English even though the whole system is Spanish. `Intl` doesn't help here (it
 * resolves to the ICU default `en-US` when `LANG=C`). macOS records the real
 * preference in `AppleLocale`/`AppleLanguages`; Linux/Windows surface it via
 * `LANGUAGE`/`Intl`. We read those as a LAST resort, after every explicit
 * env/config source, so an explicit `LANG=en_US` still wins.
 */
let osLocaleCache: Locale | null | undefined;
function osPreferredLocale(): Locale | null {
  if (osLocaleCache !== undefined) return osLocaleCache;
  // ONLY auto-detect the OS language for an INTERACTIVE terminal. Scripted/piped/
  // CI/test runs must stay deterministic (English default unless LANG/EXCALIBUR_LANG
  // say otherwise) — otherwise the chrome would silently switch language based on
  // the machine's region, breaking reproducibility and English-asserting tests.
  if (process.stdout.isTTY !== true) {
    osLocaleCache = null;
    return null;
  }
  const match = (value: string | undefined): Locale | null => {
    const lower = (value ?? '').trim().toLowerCase();
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('en')) return 'en';
    return null;
  };
  let resolved: Locale | null = null;
  if (process.platform === 'darwin') {
    try {
      // `AppleLocale` is the system region/language (e.g. `es_ES`). 600ms cap so a
      // hung `defaults` never stalls startup; stderr discarded.
      resolved = match(
        execFileSync('defaults', ['read', '-g', 'AppleLocale'], {
          encoding: 'utf8',
          timeout: 600,
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
    } catch {
      /* best-effort — fall through to Intl below */
    }
  }
  if (resolved === null) {
    try {
      // Honours `LANGUAGE`/ICU on Linux & Windows; harmless elsewhere.
      resolved = match(new Intl.DateTimeFormat().resolvedOptions().locale);
    } catch {
      /* ignore — leave unresolved */
    }
  }
  osLocaleCache = resolved;
  return resolved;
}

/** Resolves the CLI locale from the environment + optional repo config `language`. */
export function detectCliLocale(env: NodeJS.ProcessEnv, configLanguage?: string): Locale {
  // An explicit env/config source ALWAYS wins (EXCALIBUR_LANG > config > LC_* > LANG).
  for (const candidate of [
    env['EXCALIBUR_LANG'],
    configLanguage,
    env['LC_ALL'],
    env['LC_MESSAGES'],
    env['LANG'],
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      const lower = candidate.toLowerCase();
      if (lower.startsWith('es')) return 'es';
      if (lower.startsWith('en')) return 'en';
      // A recognised-but-unsupported (e.g. `fr`) or neutral (`C`, `POSIX`) value
      // keeps scanning lower-precedence sources rather than forcing `en`.
    }
  }
  // Environment inconclusive → fall back to the OS's preferred UI language so a
  // Spanish machine gets Spanish chrome even with `LANG=C`/unset. Then `en`.
  return osPreferredLocale() ?? detectLocale({ env, configLanguage });
}

/** Builds the CLI translator for a resolved locale. */
export function buildCliTranslator(locale: Locale): Translator {
  return makeTranslator(CATALOGS, locale);
}

export { EN, ES };
