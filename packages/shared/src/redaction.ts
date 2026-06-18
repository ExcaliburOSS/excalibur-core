/**
 * Secret redaction (Build Contract §4.3, OSS spec §17).
 *
 * Masks well-known credential formats with `[REDACTED]` before prompts or
 * logs leave the process. Patterns are intentionally a little aggressive:
 * for a redactor, a false positive is far cheaper than a leaked secret.
 *
 * Lives in `@excalibur/shared` so every package — model-gateway, agent-runtime,
 * context-engine (skill/instruction scanning), core — applies the SAME
 * redaction at the point data is captured, not just before a model call.
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

/**
 * Stripe secret/restricted keys: `sk_live_`/`sk_test_`/`rk_live_`/`rk_test_`
 * (underscore form — NOT caught by the hyphenated `sk-` pattern above).
 * Publishable `pk_…` keys are intentionally not redacted (they are public).
 */
const STRIPE_SECRET_KEY = /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g;

/**
 * JSON Web Tokens: three base64url segments where the header and payload both
 * begin `eyJ` (the base64url of `{"`). Very low false-positive — `eyJ.eyJ.…`
 * essentially never occurs outside a JWT. The signature segment may be empty
 * (`alg:none`), hence `*` on the third group.
 */
const JWT = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/**
 * Credentials embedded in a connection string / URL userinfo
 * (`scheme://user:password@host`). Keeps the scheme and username, masks the
 * password. Covers postgres/mysql/redis/mongodb/amqp/https URLs.
 */
const CONNECTION_STRING_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/[^:@/\s]+):([^@/\s]+)@/gi;

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

/**
 * Long opaque tokens with no keyword context (e.g. a credential pasted on its
 * own line). Candidates are base64/base64url/hex runs of ≥40 chars; we redact
 * only those with high Shannon entropy that ALSO mix upper- and lower-case
 * letters. That last condition is what spares the common high-length tokens
 * that are NOT secrets: git SHAs (lowercase hex), decimal ids, and lowercase
 * UUIDs — while still catching random API tokens. A false positive here only
 * costs a masked string in a prompt/log; a miss leaks a credential.
 */
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{40,}/g;
const ENTROPY_BITS_THRESHOLD = 4.0;

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksLikeHighEntropySecret(token: string): boolean {
  // Must mix cases — excludes lowercase-hex SHAs / all-digit ids / lowercase UUIDs.
  if (!(/[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token))) {
    return false;
  }
  return shannonBitsPerChar(token) >= ENTROPY_BITS_THRESHOLD;
}

/** Masks all known secret patterns in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  let result = text;
  result = result.replace(PRIVATE_KEY_BLOCK, REDACTED);
  result = result.replace(JWT, REDACTED);
  result = result.replace(OPENAI_STYLE_KEY, REDACTED);
  result = result.replace(STRIPE_SECRET_KEY, REDACTED);
  result = result.replace(AWS_ACCESS_KEY, REDACTED);
  result = result.replace(GITHUB_TOKEN, REDACTED);
  result = result.replace(NPM_TOKEN, REDACTED);
  result = result.replace(GOOGLE_OAUTH_TOKEN, REDACTED);
  result = result.replace(SLACK_TOKEN, REDACTED);
  result = result.replace(AUTHORIZATION_BEARER, `$1${REDACTED}`);
  result = result.replace(
    CONNECTION_STRING_CREDS,
    (_match, prefix: string) => `${prefix}:${REDACTED}@`,
  );
  result = result.replace(REGISTRY_AUTH_SECRET, `$1$2${REDACTED}`);
  result = result.replace(
    KEY_VALUE_SECRET,
    (_match, key: string, delimiter: string, quote: string) =>
      `${key}${delimiter}${quote}${REDACTED}`,
  );
  result = result.replace(HIGH_ENTROPY_CANDIDATE, (token) =>
    looksLikeHighEntropySecret(token) ? REDACTED : token,
  );
  return result;
}
