/**
 * CLI credential storage for Enterprise sync (Build Contract §4.8).
 *
 * `excalibur login` persists `{ baseUrl, apiKey }` to
 * `~/.config/excalibur/credentials.json` with file mode 0600. The
 * `EXCALIBUR_API_KEY` / `EXCALIBUR_BASE_URL` environment variables always take
 * precedence over the file (per field), which is how CI environments inject
 * credentials without touching the filesystem.
 *
 * @experimental Enterprise sync is experimental in M1.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { ConfigValidationError } from '@excalibur/shared';

/** Environment variable that overrides the stored API key. */
export const EXCALIBUR_API_KEY_ENV = 'EXCALIBUR_API_KEY';
/** Environment variable that overrides the stored base URL. */
export const EXCALIBUR_BASE_URL_ENV = 'EXCALIBUR_BASE_URL';
/** Credentials file location relative to the user's home directory. */
export const CREDENTIALS_RELATIVE_PATH = path.join('.config', 'excalibur', 'credentials.json');
/** POSIX mode enforced on the credentials file (owner read/write only). */
export const CREDENTIALS_FILE_MODE = 0o600;
/** POSIX mode used when creating the credentials directory. */
export const CREDENTIALS_DIR_MODE = 0o700;

/**
 * Zod companion for {@link CliCredentials}.
 *
 * @experimental
 */
export const cliCredentialsSchema = z.object({
  /** Enterprise API base URL, e.g. `https://app.excalibur.example`. */
  baseUrl: z.string().trim().min(1, 'baseUrl must not be empty').url('baseUrl must be a valid URL'),
  /** Enterprise API key. Never logged, never written into `.excalibur/`. */
  apiKey: z.string().trim().min(1, 'apiKey must not be empty'),
});

/** Stored CLI credentials for the Enterprise API. @experimental */
export type CliCredentials = z.infer<typeof cliCredentialsSchema>;

/**
 * Dependency-injection options shared by the credential helpers; defaults are
 * the real home directory and `process.env`. Designed for testability — tests
 * point `baseDir` at a temp directory instead of the user's home.
 *
 * @experimental
 */
export interface CredentialsOptions {
  /** Stand-in for `os.homedir()`; credentials live at `<baseDir>/.config/excalibur/credentials.json`. */
  baseDir?: string;
  /** Stand-in for `process.env` (only the two `EXCALIBUR_*` variables are read). */
  env?: Record<string, string | undefined>;
}

/** Resolves the absolute credentials file path for a given base directory. */
export function getCredentialsFilePath(baseDir?: string): string {
  return path.join(baseDir ?? os.homedir(), CREDENTIALS_RELATIVE_PATH);
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readCredentialsFile(filePath: string): Partial<CliCredentials> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {};
    }
    throw new ConfigValidationError(`Cannot read CLI credentials file at ${filePath}`, {
      path: filePath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never include file content in the error: it may hold a partial secret.
    throw new ConfigValidationError(`CLI credentials file at ${filePath} is not valid JSON`, {
      path: filePath,
    });
  }

  const result = cliCredentialsSchema.partial().safeParse(parsed);
  if (!result.success) {
    throw new ConfigValidationError(`CLI credentials file at ${filePath} has an invalid shape`, {
      path: filePath,
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/**
 * Loads CLI credentials, merging (per field) the `EXCALIBUR_API_KEY` /
 * `EXCALIBUR_BASE_URL` environment variables over the
 * `~/.config/excalibur/credentials.json` file. Environment variables win.
 *
 * @returns The resolved credentials, or `null` when no complete credential
 *   pair is configured (the local-only default).
 * @throws ConfigValidationError when the file exists but is unreadable,
 *   malformed, or the resolved pair is invalid (e.g. a non-URL base URL).
 * @experimental
 */
export function loadCliCredentials(options: CredentialsOptions = {}): CliCredentials | null {
  const env = options.env ?? process.env;
  const envBaseUrl = nonEmpty(env[EXCALIBUR_BASE_URL_ENV]);
  const envApiKey = nonEmpty(env[EXCALIBUR_API_KEY_ENV]);

  // Only touch the filesystem when the environment does not fully resolve.
  const fromFile =
    envBaseUrl !== undefined && envApiKey !== undefined
      ? {}
      : readCredentialsFile(getCredentialsFilePath(options.baseDir));

  const baseUrl = envBaseUrl ?? nonEmpty(fromFile.baseUrl);
  const apiKey = envApiKey ?? nonEmpty(fromFile.apiKey);
  if (baseUrl === undefined || apiKey === undefined) {
    return null;
  }

  const result = cliCredentialsSchema.safeParse({ baseUrl, apiKey });
  if (!result.success) {
    throw new ConfigValidationError('Resolved CLI credentials are invalid', {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return result.data;
}

/**
 * Persists CLI credentials to `~/.config/excalibur/credentials.json`,
 * creating the directory (mode 0700) when missing and enforcing file mode
 * 0600 even when the file already existed with looser permissions.
 *
 * @returns The absolute path of the written file.
 * @throws ConfigValidationError when the credentials are invalid.
 * @experimental
 */
export function saveCliCredentials(
  credentials: CliCredentials,
  options: Pick<CredentialsOptions, 'baseDir'> = {},
): string {
  const result = cliCredentialsSchema.safeParse(credentials);
  if (!result.success) {
    throw new ConfigValidationError('Cannot save invalid CLI credentials', {
      issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }

  const filePath = getCredentialsFilePath(options.baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: CREDENTIALS_DIR_MODE });
  fs.writeFileSync(filePath, `${JSON.stringify(result.data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: CREDENTIALS_FILE_MODE,
  });
  // `writeFileSync` only applies `mode` on creation; enforce it on overwrite.
  fs.chmodSync(filePath, CREDENTIALS_FILE_MODE);
  return filePath;
}
