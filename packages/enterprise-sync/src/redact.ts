/**
 * Secret redaction for sync error diagnostics.
 *
 * Error responses from the Enterprise API may echo request headers or contain
 * tokens (e.g. proxy error pages). Anything that ends up in a thrown
 * `ProviderError.details` — and from there in `events.jsonl` or terminal
 * output — must be scrubbed first.
 *
 * @experimental Part of the experimental M1 enterprise-sync package.
 */

const REDACTED = '[REDACTED]';

/** Maximum number of characters kept from a response body in error details. */
export const MAX_BODY_EXCERPT_LENGTH = 256;

/**
 * Token-shaped patterns masked entirely. Mirrors the model-gateway
 * `redactSecrets` catalogue (Build Contract §4.3) for the subset that can
 * plausibly appear in an HTTP error body.
 */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  // Authorization header echoes.
  /bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // OpenAI-style keys.
  /sk-[A-Za-z0-9_-]{8,}/g,
  // AWS access key ids.
  /AKIA[A-Z0-9]{12,}/g,
  // GitHub tokens (ghp_/gho_/ghs_).
  /gh[pos]_[A-Za-z0-9]{8,}/g,
  // Slack tokens.
  /xox[a-z]?-[A-Za-z0-9-]{8,}/g,
  // PEM private key blocks.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/g,
];

/**
 * `key: value` / `key=value` style secrets — the key is kept, the value is
 * masked.
 */
const KEY_VALUE_PATTERN =
  /("?(?:api[_-]?key|apikey|password|secret|token|authorization)"?\s*[:=]\s*)("?)[^"',;\s}{][^"',;\s}]*\2/gi;

/**
 * Masks known secret shapes inside arbitrary text with `[REDACTED]`.
 *
 * @param text - Raw text (e.g. an HTTP response body).
 * @param knownSecrets - Literal values that must never appear (e.g. the API
 *   key currently in use); they are removed before pattern matching.
 */
export function redactSyncSecrets(text: string, knownSecrets: ReadonlyArray<string> = []): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (secret.length > 0) {
      result = result.split(secret).join(REDACTED);
    }
  }
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  result = result.replace(KEY_VALUE_PATTERN, `$1$2${REDACTED}$2`);
  return result;
}

/**
 * Builds the redacted, length-capped body excerpt attached to `sync_failed`
 * errors. Redaction happens before truncation so a secret straddling the cut
 * point cannot leak.
 */
export function buildBodyExcerpt(
  body: string,
  knownSecrets: ReadonlyArray<string> = [],
  maxLength: number = MAX_BODY_EXCERPT_LENGTH,
): string {
  const redacted = redactSyncSecrets(body, knownSecrets).trim();
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, maxLength)}… (truncated)`;
}
