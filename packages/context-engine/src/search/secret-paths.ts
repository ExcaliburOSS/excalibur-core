/**
 * Secret-path classification for deterministic code-search retrieval.
 *
 * Retrieval must NEVER surface credential-bearing files into a model prompt.
 * This is intentionally narrower than the domain `SENSITIVE_DIR_NAMES` in
 * `patterns.ts`: `auth/` and `billing/` are legitimate application code that a
 * user can ask about, whereas `secrets/`, `credentials/` and `.env`/key files
 * hold raw secrets and are excluded outright (defense in depth — the gateway's
 * `redactSecrets()` still runs on whatever does reach the prompt).
 */

/** Directory names whose contents are excluded from retrieval entirely. */
export const SECRET_DIR_NAMES: ReadonlySet<string> = new Set([
  'secrets',
  'secret',
  'credentials',
  'credential',
  '.ssh',
  '.gnupg',
  // Tool config dirs that commonly hold raw tokens/credentials.
  '.aws',
  '.docker',
  '.kube',
  '.gcloud',
]);

/**
 * Basenames of files excluded from retrieval entirely (case-insensitive).
 * Specific credential filenames only — never broad names like `config.json`
 * or `token.ts`, which are overwhelmingly legitimate application code.
 */
const SECRET_FILE_BASENAMES: ReadonlySet<string> = new Set([
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  // Tool credential files that hold raw tokens (often base64 auth).
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.dockercfg',
  '.git-credentials',
  '.htpasswd',
  '.pgpass',
  '.boto',
]);

/** Filename suffixes (extensions) that indicate a secret-bearing file. */
const SECRET_FILE_SUFFIXES: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.keystore',
  '.jks',
  '.crt',
  '.cer',
  '.der',
  '.asc',
  '.gpg',
];

/** Matches `.env`, `.env.local`, `.env.production`, … (any `.env*`). */
const ENV_FILE_PATTERN = /^\.env(\..+)?$/i;

function basename(posixPath: string): string {
  const parts = posixPath.split('/');
  return parts[parts.length - 1] ?? posixPath;
}

/**
 * True when a repo-relative POSIX path is secret-bearing and must be excluded
 * from retrieval: any segment is a secret directory, or the basename is an
 * `.env*` file / a known key file / has a secret-bearing extension.
 */
export function isSecretPath(posixPath: string): boolean {
  const segments = posixPath.split('/');
  for (const segment of segments) {
    if (SECRET_DIR_NAMES.has(segment.toLowerCase())) {
      return true;
    }
  }
  const base = basename(posixPath).toLowerCase();
  if (ENV_FILE_PATTERN.test(base)) {
    return true;
  }
  if (SECRET_FILE_BASENAMES.has(base)) {
    return true;
  }
  return SECRET_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}
