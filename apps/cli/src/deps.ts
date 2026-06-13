import * as os from 'node:os';
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
}

export function defaultDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    ui: overrides.ui ?? createUi(),
    cwd: overrides.cwd ?? ((): string => process.cwd()),
    homeDir: overrides.homeDir ?? ((): string => os.homedir()),
    env: overrides.env ?? process.env,
    includeUserGlobal: overrides.includeUserGlobal ?? true,
  };
}
