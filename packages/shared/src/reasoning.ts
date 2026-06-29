/**
 * Strips model REASONING from user-facing narration (RUN-FIX-22).
 *
 * Some models inline their chain-of-thought into the ordinary content stream as
 * `<antThinking>…</antThinking>` / `<thinking>…</thinking>` / `<think>…</think>` /
 * `<reasoning>…</reasoning>` blocks (there is no separate reasoning channel on the
 * OpenAI-compatible delta), and they sometimes prefix prose with a stray status glyph
 * (a red ✗ or a 🔧). None of that is meant for the user. This removes it before the
 * narration is ever shown — at the adapter source AND defensively at the TUI render
 * boundary — so raw thinking can never leak to the screen.
 *
 * Streaming-safe: applied to the ACCUMULATED content each delta. A complete block is
 * removed; a DANGLING opening tag (the close hasn't arrived yet) — including a partial
 * tag arriving character-by-character (`<antTh`) — is cut to end, so the hidden segment
 * never appears-then-disappears (the visible prose only ever grows monotonically → no
 * flicker). The tag match is tag-NAME-anchored, so ordinary prose containing `<` (e.g.
 * `a < b`, a generic `Array<T>`) is never clipped.
 */

const TAG = '(?:antThinking|thinking|think|reasoning)';
const COMPLETE_BLOCK = new RegExp(`<\\s*${TAG}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${TAG}\\s*>`, 'gi');
const OPEN_TAG = new RegExp(`<\\s*${TAG}\\b`, 'i');
const PARTIAL_OPEN_AT_END = /<\s*([a-zA-Z]+)$/;
const KNOWN_TAGS = ['antthinking', 'thinking', 'think', 'reasoning'];
// A leading run of stray status glyphs / emoji + surrounding whitespace the model
// sometimes emits before its prose (a red cross or a tool emoji), which would otherwise
// read as a failed-phase marker.
// Status glyphs (✕ ✗ ✘ × ⚠ ❌ ⚙ 🔧 🛠 🔨) as single-code-point escapes + the optional
// VS-16 emoji variation selector, so the character class never holds a base+combining pair.
const LEADING_GLYPHS = /^(?:\s|[✕✗✘×⚠❌⚙\u{1f527}\u{1f6e0}\u{1f528}]|️)+/u;

/** Remove reasoning blocks + a leading stray glyph run from narration content. */
export function stripReasoning(text: string): string {
  if (text.length === 0) {
    return text;
  }
  // 1. Remove every COMPLETE reasoning block.
  let removed = false;
  let out = text.replace(COMPLETE_BLOCK, () => {
    removed = true;
    return '';
  });
  // 2. Drop a DANGLING unclosed block — the opening tag arrived but its close hasn't yet.
  const openIndex = out.search(OPEN_TAG);
  if (openIndex !== -1) {
    out = out.slice(0, openIndex);
    removed = true;
  } else {
    // 2b. A partial opening tag at the very end (streaming char-by-char, e.g. `<antTh`).
    const partial = out.match(PARTIAL_OPEN_AT_END);
    if (
      partial !== null &&
      partial.index !== undefined &&
      KNOWN_TAGS.some((tag) => tag.startsWith(partial[1]!.toLowerCase()))
    ) {
      out = out.slice(0, partial.index);
      removed = true;
    }
  }
  // 3. Strip a leading run of stray status glyphs / emoji.
  out = out.replace(LEADING_GLYPHS, '');
  // 4. When a block was cut, drop the now-dangling trailing whitespace it left behind.
  return removed ? out.replace(/\s+$/u, '') : out;
}
