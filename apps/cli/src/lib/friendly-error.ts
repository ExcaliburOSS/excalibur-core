import { isExcaliburError } from '@excalibur/shared';
import type { CliDeps } from '../deps';

/**
 * P0-6 (error UX) — the ONE funnel that turns any thrown value into a WARM,
 * SPECIFIC, ACTIONABLE user-facing message, keeping the raw exception behind a
 * debug affordance (`/why` or `EXCALIBUR_DEBUG=1`). Before this, ~26 catch sites
 * did `deps.ui.error(error.message)` — so a `TypeError`, an `ENOENT` or an
 * `ECONNREFUSED` landed on the user verbatim in scary red, with no "what were we
 * doing / where / what next". That was the founder's "mensajes generales de error
 * robóticos ante cualquier mínimo fallo". The armor kept the shell alive; this
 * makes the survival SOUND like a calm colleague, not a stack trace.
 */

export type ErrorClass =
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'permission'
  | 'not_found'
  | 'timeout'
  | 'git'
  | 'cancelled'
  | 'provider'
  | 'unknown';

export interface FriendlyError {
  /** The warm one-liner shown to the user (no jargon, no stack). */
  headline: string;
  /** An actionable next step, when we can offer one. */
  hint?: string;
  /** The raw message — surfaced ONLY on debug / `/why`, never dumped by default. */
  detail: string;
  code: ErrorClass;
}

/** The last friendly error this session — revealed in full by `/why`. */
let lastDetail: { headline: string; detail: string; at: number } | null = null;

/** Records the raw detail so `/why` can show it after a warm message. */
export function rememberErrorDetail(headline: string, detail: string): void {
  lastDetail = { headline, detail, at: Date.now() };
}

/** The stashed last-error detail for `/why`, or null when there is none. */
export function lastErrorDetail(): { headline: string; detail: string } | null {
  return lastDetail === null ? null : { headline: lastDetail.headline, detail: lastDetail.detail };
}

function rawMessage(error: unknown): string {
  if (isExcaliburError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Extracts a `.code`/`.status` where present (Node errors, HTTP-ish errors). */
function codeOf(error: unknown): string {
  const e = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  return [e?.code, e?.status, e?.statusCode]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v))
    .join(' ');
}

/**
 * Classifies a thrown value by inspecting its `.code`/`.status` and message —
 * the taxonomy each maps to a warm, specific, actionable message.
 */
export function classifyError(error: unknown): ErrorClass {
  // An ExcaliburError carries its own intended message; treat as provider/domain.
  if (isExcaliburError(error)) return 'provider';
  const hay = `${codeOf(error)} ${rawMessage(error)}`.toLowerCase();
  if (/abort|cancell?ed|sigint/.test(hay)) return 'cancelled';
  if (
    /econnrefused|enotfound|eai_again|econnreset|etimedout.*connect|network|dns|socket hang up|fetch failed/.test(
      hay,
    )
  )
    return 'network';
  if (
    /\b401\b|\b403\b|unauthor|forbidden|invalid api key|invalid_api_key|authentication|api key/.test(
      hay,
    )
  )
    return 'auth';
  if (/\b429\b|rate.?limit|too many requests|quota/.test(hay)) return 'rate_limit';
  if (/eacces|eperm|permission denied|not permitted/.test(hay)) return 'permission';
  if (/enoent|no such file|not found|\b404\b/.test(hay)) return 'not_found';
  if (/etimedout|timeout|timed out/.test(hay)) return 'timeout';
  if (/git |worktree|merge|conflict|not a git repo|fatal: /.test(hay)) return 'git';
  if (/\b5\d\d\b|provider|model|completion|gateway/.test(hay)) return 'provider';
  return 'unknown';
}

/**
 * Builds the friendly form. `doing` is a short present-participle of what was in
 * flight ("running that command", "reaching the model") that makes the headline
 * concrete without leaking internals.
 */
export function friendlyError(error: unknown, opts: { doing?: string } = {}): FriendlyError {
  const detail = rawMessage(error);
  const code = classifyError(error);
  const doing = opts.doing;
  const ctx = doing !== undefined ? ` while ${doing}` : '';
  switch (code) {
    case 'cancelled':
      return { code, detail, headline: `Okay — I stopped${ctx}.` };
    case 'network':
      return {
        code,
        detail,
        headline: `I couldn't reach the network${ctx}.`,
        hint: 'Check your connection — say "retry" and I\'ll try again.',
      };
    case 'auth':
      return {
        code,
        detail,
        headline: 'The model rejected the API key.',
        hint: 'Double-check the key in your provider config (excalibur models test).',
      };
    case 'rate_limit':
      return {
        code,
        detail,
        headline: 'The model is rate-limiting us right now.',
        hint: 'Give it a moment and retry, or switch model with /model.',
      };
    case 'permission':
      return {
        code,
        detail,
        headline: `I don't have permission for that${ctx}.`,
        hint: 'Check the file/directory permissions and try again.',
      };
    case 'not_found':
      return { code, detail, headline: `I couldn't find that${ctx}.` };
    case 'timeout':
      return {
        code,
        detail,
        headline: `That took too long${ctx} and I stopped waiting.`,
        hint: 'Retry, or narrow the task if it was large.',
      };
    case 'git':
      return {
        code,
        detail,
        headline: `Git got in the way${ctx}.`,
        hint: 'Check `git status` — there may be a conflict or an uncommitted change.',
      };
    case 'provider':
      // A domain/provider error usually has a genuinely useful message — surface
      // it (it's ours, not a raw stack), lightly framed.
      return { code, detail, headline: detail };
    default: {
      // An unclassified error often carries a genuinely useful, clean message
      // (a domain error, a validation line) — keep it. Only a stack-like or opaque
      // message (multi-line, `at file:line` frames, very long) is replaced with the
      // reassuring generic, with the raw kept for `/why`. This preserves SPECIFICITY
      // where it exists instead of flattening everything to "something went wrong".
      const looksLikeStack =
        detail.length === 0 ||
        detail.length > 200 ||
        detail.includes('\n') ||
        /\bat\s+\S+:\d+/.test(detail) ||
        // A JS runtime-error prefix is internal jargon, not a user message.
        /^(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AssertionError):/.test(
          detail,
        );
      if (!looksLikeStack) {
        return { code, detail, headline: detail };
      }
      return {
        code,
        detail,
        headline: `Something went wrong${ctx} — I stopped there so nothing's half-done.`,
        hint: 'Say "retry" to try again (/why shows the technical detail).',
      };
    }
  }
}

/**
 * Renders a friendly error to the user (a warm line + an optional dim hint) and
 * stashes the raw detail for `/why`. Never dumps the raw exception by default;
 * `EXCALIBUR_DEBUG` appends the detail inline for the impatient.
 */
export function reportFriendly(deps: CliDeps, error: unknown, opts: { doing?: string } = {}): void {
  const f = friendlyError(error, opts);
  rememberErrorDetail(f.headline, f.detail);
  deps.ui.warn(f.headline);
  if (f.hint !== undefined) {
    deps.ui.info(f.hint);
  }
  if (deps.env['EXCALIBUR_DEBUG'] !== undefined && f.detail !== f.headline) {
    deps.ui.info(`  ${f.detail}`);
  }
}
