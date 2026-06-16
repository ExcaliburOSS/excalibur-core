import * as os from 'node:os';
import type { Locale, Translator } from '@excalibur/shared';
import { buildCliTranslator, detectCliLocale } from './i18n';
import { Ui, createUi } from './ui';

/**
 * Injectable CLI dependencies. Commands never read process state directly:
 * tests swap in memory streams, a temp working directory and a temp home so
 * every behavior is observable and deterministic.
 */
export interface CliDeps {
  ui: Ui;
  /** Working directory = repository root for every command. */
  cwd: () => string;
  /** Home directory used for user-global instruction scanning and credentials. */
  homeDir: () => string;
  /** Environment (API key env var presence checks, enterprise overrides). */
  env: NodeJS.ProcessEnv;
  /**
   * Whether ISD scanning includes `~/.claude/**` user-global sources
   * (Build Contract §4.5: on in the CLI). Tests switch it off so the
   * developer's real home never leaks into assertions.
   */
  includeUserGlobal: boolean;
  /** Active chrome locale (auto-detected from env; `en` in tests). */
  locale: Locale;
  /** Translator for the active locale — `t(key, vars)` (plan §"Idioma"). */
  t: Translator;
}

export function defaultDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const env = overrides.env ?? process.env;
  // Env-based locale auto-detection; a repo's config `language` refines this for
  // surfaces that load config (the interactive session rebuilds its translator).
  const locale = overrides.locale ?? detectCliLocale(env);
  return {
    ui: overrides.ui ?? createUi(),
    cwd: overrides.cwd ?? ((): string => process.cwd()),
    homeDir: overrides.homeDir ?? ((): string => os.homedir()),
    env,
    includeUserGlobal: overrides.includeUserGlobal ?? true,
    locale,
    t: overrides.t ?? buildCliTranslator(locale),
  };
}
