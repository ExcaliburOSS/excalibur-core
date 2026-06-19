import {
  detectLocale,
  makeTranslator,
  type Catalog,
  type Locale,
  type Translator,
} from '@excalibur/shared';
import { EN } from './en';
import { ES } from './es';

/**
 * The CLI's message catalogs + translator wiring (plan §"Idioma"). The chrome is
 * keyed, not hardcoded; `EN` is the source-of-truth catalog and `ES` the Spanish
 * translation (falling back to `EN` per key). Locale is auto-detected
 * (EXCALIBUR_LANG > config `language` > LANG/LC_* > en). Migration of the
 * remaining literals is incremental — every key added to `EN`/`ES` here.
 */
const CATALOGS: Record<Locale, Catalog> = { en: EN, es: ES };

/** Resolves the CLI locale from the environment + optional repo config `language`. */
export function detectCliLocale(env: NodeJS.ProcessEnv, configLanguage?: string): Locale {
  return detectLocale({ env, configLanguage });
}

/** Builds the CLI translator for a resolved locale. */
export function buildCliTranslator(locale: Locale): Translator {
  return makeTranslator(CATALOGS, locale);
}

export { EN, ES };
