/**
 * Detects a provider "context length exceeded" error across vendors, so the REPL
 * can compact and retry the turn instead of surfacing a raw failure. Matches the
 * error message (and any nested `cause` / `error` / `details`), case-insensitive.
 * Conservative: only fires on phrasings that clearly mean the prompt was too big.
 */

const OVERFLOW_RE =
  /context[_ ](?:length|window)|context[_ ]length[_ ]exceeded|prompt is too long|too many (?:input )?tokens|maximum (?:context|prompt|input)|exceeds? (?:the )?(?:maximum|context|model'?s? context|token)|reduce the (?:length|number of)|input (?:is )?too long|string too long/i;

/** True when `error` looks like a model context-window overflow. */
export function isContextOverflowError(error: unknown): boolean {
  const parts: string[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 4) {
      return;
    }
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (typeof obj['message'] === 'string') {
        parts.push(obj['message']);
      }
      if (typeof obj['code'] === 'string') {
        parts.push(obj['code']);
      }
      if (typeof obj['details'] === 'string') {
        parts.push(obj['details']);
      }
      collect(obj['error'], depth + 1);
      collect(obj['cause'], depth + 1);
    }
  };
  collect(error, 0);
  return OVERFLOW_RE.test(parts.join(' \n '));
}
