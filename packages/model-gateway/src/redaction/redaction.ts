/**
 * Secret redaction (Build Contract §4.3, OSS spec §17).
 *
 * Masks well-known credential formats with `[REDACTED]` before prompts or
 * logs leave the process. Patterns are intentionally a little aggressive:
 * for a redactor, a false positive is far cheaper than a leaked secret.
 */

const REDACTED = '[REDACTED]';

/**
 * `-----BEGIN … PRIVATE KEY-----` blocks (RSA/EC/OPENSSH/ENCRYPTED/plain).
 * The body is length-bounded so an unterminated header can't trigger
 * catastrophic backtracking on a large file (a PEM body never approaches 64k).
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{1,65536}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** OpenAI-style keys: `sk-…` incl. `sk-proj-…` and Anthropic `sk-ant-…`. */
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g;

/** AWS access key ids: `AKIA` + 16 uppercase alphanumerics. */
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;

/** GitHub tokens: classic `ghp_`/`gho_`/`ghs_` plus fine-grained `github_pat_`. */
const GITHUB_TOKEN = /\b(?:gh[pos]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** npm automation/publish tokens: `npm_` + 36+ base62. */
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{36,}\b/g;

/** Google OAuth access tokens: `ya29.<token>`. */
const GOOGLE_OAUTH_TOKEN = /\bya29\.[A-Za-z0-9_-]{10,}/g;

/** Slack tokens: `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`, `xoxs-`, … */
const SLACK_TOKEN = /\bxox[a-z]-[A-Za-z0-9-]{8,}\b/g;

/**
 * Registry/credential-file auth assignments — npm `.npmrc` (`_auth`,
 * `_authToken`, `_password`) and similar, whose values are often base64 and
 * therefore not caught by the prefix-based patterns above. Keeps the key and
 * delimiter, masks the value.
 */
const REGISTRY_AUTH_SECRET = /\b(_auth(?:[Tt]oken)?|_password)(\s*=\s*)([^\s"';]+)/g;

/** `Authorization: Bearer <token>` headers — keeps the header name, masks the token. */
const AUTHORIZATION_BEARER = /(\bauthorization\s*:\s*bearer\s+)[^\s"']+/gi;

/**
 * `password=…` / `apiKey: …` style assignments in env lines, YAML, JSON and
 * URLs. Keeps the key and delimiter, masks only the value.
 */
const KEY_VALUE_SECRET =
  /\b(password|passwd|pwd|secret|client[_-]?secret|secret[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token)\b(["']?\s*[:=]\s*)(["']?)([^\s"',;&]+)/gi;

/** Masks all known secret patterns in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  let result = text;
  result = result.replace(PRIVATE_KEY_BLOCK, REDACTED);
  result = result.replace(OPENAI_STYLE_KEY, REDACTED);
  result = result.replace(AWS_ACCESS_KEY, REDACTED);
  result = result.replace(GITHUB_TOKEN, REDACTED);
  result = result.replace(NPM_TOKEN, REDACTED);
  result = result.replace(GOOGLE_OAUTH_TOKEN, REDACTED);
  result = result.replace(SLACK_TOKEN, REDACTED);
  result = result.replace(AUTHORIZATION_BEARER, `$1${REDACTED}`);
  result = result.replace(REGISTRY_AUTH_SECRET, `$1$2${REDACTED}`);
  result = result.replace(
    KEY_VALUE_SECRET,
    (_match, key: string, delimiter: string, quote: string) =>
      `${key}${delimiter}${quote}${REDACTED}`,
  );
  return result;
}
