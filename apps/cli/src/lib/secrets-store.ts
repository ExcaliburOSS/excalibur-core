import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Local secret-at-rest store for model-provider API keys (the comfortable
 * onboarding). When a user PASTES a key during setup, Excalibur writes it here —
 * a `.env`-style file at `~/.config/excalibur/secrets.env` (mode 0600) — and
 * loads it into `process.env` on every launch. `providers.yaml` keeps storing
 * ONLY the env var NAME (never the value), so the committed config stays free of
 * secrets; this file (outside any repo, never committed) holds the value.
 *
 * Precedence on load: a variable already present in the real environment ALWAYS
 * wins — the file only FILLS GAPS, so an explicit `export` / CI-injected key is
 * never clobbered. Mirrors the home-dir, owner-only pattern already used by
 * `enterprise-sync`'s `credentials.json`.
 */

/** Secrets file location relative to the user's home directory. */
export const SECRETS_RELATIVE_PATH = join('.config', 'excalibur', 'secrets.env');
/** POSIX mode enforced on the secrets file (owner read/write only). */
export const SECRETS_FILE_MODE = 0o600;
/** POSIX mode used when creating the secrets directory. */
export const SECRETS_DIR_MODE = 0o700;

/** Valid env var name (uppercase, digits, underscores; not starting with a digit). */
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Resolves the absolute secrets file path for a given base directory. */
export function secretsFilePath(baseDir?: string): string {
  return join(baseDir ?? homedir(), SECRETS_RELATIVE_PATH);
}

function readFileOrEmpty(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return '';
    }
    throw error;
  }
}

/**
 * Parses a `.env`-style text into ordered key/value pairs. Blank lines and `#`
 * comments are ignored; each entry splits on the FIRST `=`; surrounding single
 * or double quotes are stripped. Malformed lines (no `=`, or an invalid name)
 * are skipped rather than throwing — a corrupt secrets file must never crash the
 * CLI on startup.
 */
export function parseEnvFile(text: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = line.slice(0, eq).trim();
    if (!ENV_VAR_NAME_PATTERN.test(name)) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(".*"|'.*')$/.test(value)) {
      value = value.slice(1, -1);
    }
    entries.push([name, value]);
  }
  return entries;
}

/**
 * Loads the secrets file into `env`, FILLING GAPS only: a variable already set
 * (non-empty) in `env` is left untouched (the real environment wins). Missing
 * file → no-op. Returns the number of variables actually written.
 */
export function loadSecretsIntoEnv(env: NodeJS.ProcessEnv = process.env, baseDir?: string): number {
  const text = readFileOrEmpty(secretsFilePath(baseDir));
  if (text.length === 0) {
    return 0;
  }
  let loaded = 0;
  for (const [name, value] of parseEnvFile(text)) {
    if ((env[name] ?? '').length === 0 && value.length > 0) {
      env[name] = value;
      loaded += 1;
    }
  }
  return loaded;
}

/**
 * Upserts `name=value` into the secrets file (creating the dir at 0700 and the
 * file at 0600, enforced even on overwrite). Existing entries are preserved and
 * order is kept; an existing `name` is replaced in place. Returns the file path.
 *
 * @throws Error when `name` is not a valid env var name or `value` is empty.
 */
export function saveSecret(name: string, value: string, baseDir?: string): string {
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
  if (value.length === 0) {
    throw new Error('Refusing to store an empty secret value');
  }
  const filePath = secretsFilePath(baseDir);
  const existing = parseEnvFile(readFileOrEmpty(filePath));
  let replaced = false;
  const next = existing.map(([k, v]): [string, string] => {
    if (k === name) {
      replaced = true;
      return [k, value];
    }
    return [k, v];
  });
  if (!replaced) {
    next.push([name, value]);
  }
  const body = next.map(([k, v]) => `${k}=${v}`).join('\n');
  mkdirSync(dirname(filePath), { recursive: true, mode: SECRETS_DIR_MODE });
  writeFileSync(filePath, `${body}\n`, { encoding: 'utf8', mode: SECRETS_FILE_MODE });
  // `writeFileSync` only applies `mode` on creation; enforce it on overwrite.
  chmodSync(filePath, SECRETS_FILE_MODE);
  return filePath;
}
