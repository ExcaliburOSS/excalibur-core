import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import type { Locale, Translator } from '@excalibur/shared';
import { parse as parseYaml } from 'yaml';
import { buildCliTranslator, detectCliLocale } from './i18n';
import { Ui, createUi } from './ui';

/**
 * Best-effort read of `.excalibur/config.yaml`'s `language` field, so a repo can
 * pin the chrome locale (e.g. `language: es`) without an env var. Never throws —
 * a missing/invalid config just falls through to env-based detection.
 */
function readConfigLanguage(cwd: string): string | undefined {
  try {
    const path = join(cwd, '.excalibur', 'config.yaml');
    if (!existsSync(path)) {
      return undefined;
    }
    const parsed = parseYaml(readFileSync(path, 'utf8')) as { language?: unknown } | null;
    return typeof parsed?.language === 'string' ? parsed.language : undefined;
  } catch {
    return undefined;
  }
}

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
  /**
   * Optional cooperative-cancellation signal. The interactive shell sets this
   * when it runs a command in-process (the m-shell↔CLI passthrough) so Ctrl-C
   * cancels the command and returns to the prompt instead of killing the shell;
   * commands that drive long work should thread it into their core call. Unset
   * for a normal one-shot CLI invocation (the process exits anyway).
   */
  signal?: AbortSignal;
}

export function defaultDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? ((): string => process.cwd());
  // Locale precedence (plan §"Idioma"): EXCALIBUR_LANG > repo config `language`
  // > OS LC_*/LANG > en. The repo's config.yaml is read best-effort so a project
  // can pin its locale without an env var.
  const locale = overrides.locale ?? detectCliLocale(env, readConfigLanguage(cwd()));
  return {
    ui: overrides.ui ?? createUi(),
    cwd,
    homeDir: overrides.homeDir ?? ((): string => os.homedir()),
    env,
    includeUserGlobal: overrides.includeUserGlobal ?? true,
    locale,
    t: overrides.t ?? buildCliTranslator(locale),
    ...(overrides.signal !== undefined ? { signal: overrides.signal } : {}),
  };
}
