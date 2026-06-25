import { estimateTokens, type ChatMessage } from '@excalibur/model-gateway';
import type { AsyncSummarizer } from './model-summarizer';
import type { TranscriptEntry } from './types';

/**
 * IN-TURN context compaction (the mid-turn counterpart to session compaction).
 *
 * A single long agentic turn grows its `messages` array with every iteration
 * (assistant turns + tool results), and can overflow the model's context window.
 * {@link compactMessages} shrinks that array IN PLACE-friendly form when it goes
 * over budget, in two tiers, and — critically — keeps the result PROVIDER-VALID:
 * every `tool` result still follows its `assistant` tool-call request, and no
 * `assistant` tool-call is left without its results.
 *
 *  - Tier 1 (fast, no model call, ALWAYS valid): truncate the content of OLD
 *    `tool` messages (before the recent tail). Tool outputs (file reads, command
 *    output) are the dominant cause of in-turn growth; capping them recovers most
 *    of the budget while preserving the message structure + ids exactly.
 *  - Tier 2 (only if still over budget): summarize the MIDDLE (everything between
 *    the leading `system` messages and a safe recent-tail boundary) into a single
 *    `system` note via the cheap model, dropping the middle in whole exchanges so
 *    pairing stays valid.
 *
 * Best-effort: returns `null` when already within budget; on a summarizer failure
 * it falls back to the Tier-1 result. Never throws.
 */

export interface InTurnCompactOptions {
  /** The active model's context window, in tokens. */
  contextWindow: number;
  /** Tokens held back for the reply + headroom (the budget = window − reserve). */
  reserveTokens: number;
  /** Tokens of the recent tail kept verbatim (never pruned/summarized). */
  keepRecentTokens: number;
  /** Async summarizer for Tier 2 (the cheap model). Omit → Tier 1 only. */
  summarize?: AsyncSummarizer;
  /** Char cap applied to OLD tool outputs (before the recent tail) in Tier 1. */
  toolOutputCap?: number;
  /** Hard char cap applied to ANY tool output (even recent) — no single tool
   *  result may dominate the window. */
  maxToolOutput?: number;
}

const DEFAULT_TOOL_CAP = 600;
const DEFAULT_MAX_TOOL_OUTPUT = 4000;

/** Total estimated tokens across a message list. */
function tokensOf(messages: ReadonlyArray<ChatMessage>): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/** Index where the recent tail begins — accumulating from the end up to `keep`. */
function tailStart(messages: ReadonlyArray<ChatMessage>, keep: number): number {
  let tail = 0;
  let i = messages.length;
  while (i > 0) {
    i -= 1;
    tail += estimateTokens((messages[i] as ChatMessage).content);
    if (tail >= keep) {
      break;
    }
  }
  return i;
}

/**
 * Tier 1: truncate `tool` outputs — aggressively for OLD ones (index < `from`)
 * with `softCap`, and to a `hardCap` for ANY tool result (even recent) so no
 * single output can dominate the window. Structure + ids are preserved exactly.
 */
function pruneToolOutputs(
  messages: ReadonlyArray<ChatMessage>,
  from: number,
  softCap: number,
  hardCap: number,
): ChatMessage[] {
  return messages.map((m, idx) => {
    if (m.role !== 'tool') {
      return m;
    }
    const cap = idx < from ? softCap : hardCap;
    if (m.content.length <= cap) {
      return m;
    }
    const elided = m.content.length - cap;
    return {
      ...m,
      content: `${m.content.slice(0, cap)}\n…[${elided} chars elided to fit the context window]`,
    };
  });
}

/** End index (exclusive) of the kept HEAD — the leading `system` messages. */
function headEnd(messages: ReadonlyArray<ChatMessage>): number {
  let i = 0;
  while (i < messages.length && (messages[i] as ChatMessage).role === 'system') {
    i += 1;
  }
  return i;
}

/**
 * Moves a tail cut FORWARD to a provider-valid boundary: a `tool` result can
 * never start the tail (its `assistant` request would be gone), so skip past any
 * `tool` messages at the cut.
 */
function safeCut(messages: ReadonlyArray<ChatMessage>, cut: number): number {
  let c = Math.max(0, Math.min(cut, messages.length));
  while (c < messages.length && (messages[c] as ChatMessage).role === 'tool') {
    c += 1;
  }
  return c;
}

/**
 * Compacts `messages` when over budget, preserving tool-call pairing. Returns the
 * compacted array, or `null` when it already fits.
 */
export async function compactMessages(
  messages: ReadonlyArray<ChatMessage>,
  opts: InTurnCompactOptions,
): Promise<ChatMessage[] | null> {
  const budget = Math.max(0, opts.contextWindow - opts.reserveTokens);
  if (budget <= 0 || tokensOf(messages) <= budget) {
    return null;
  }

  // Tier 1 — prune tool outputs (structure + ids preserved).
  const tailIdx = tailStart(messages, opts.keepRecentTokens);
  const pruned = pruneToolOutputs(
    messages,
    tailIdx,
    opts.toolOutputCap ?? DEFAULT_TOOL_CAP,
    opts.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT,
  );
  if (tokensOf(pruned) <= budget || opts.summarize === undefined) {
    return pruned;
  }

  // Tier 2 — summarize the middle between the system head and a safe tail.
  const head = headEnd(pruned);
  const cut = safeCut(pruned, Math.max(head, tailStart(pruned, opts.keepRecentTokens)));
  if (cut <= head) {
    return pruned; // nothing summarizable between head and tail
  }
  const middle = pruned.slice(head, cut);
  const tail = pruned.slice(cut);
  const entries: TranscriptEntry[] = middle.map((m, i) => ({
    id: `m:${i}`,
    seq: i,
    role: m.role === 'tool' ? 'assistant' : m.role,
    text: m.role === 'tool' ? `tool result: ${m.content}` : m.content,
    tokens: estimateTokens(m.content),
    pinned: false,
  }));
  let summaryText: string;
  try {
    summaryText = (await opts.summarize(entries)).summary;
  } catch {
    return pruned; // summarizer failed → Tier-1 result (best-effort)
  }
  const summaryMessage: ChatMessage = {
    role: 'system',
    content: `[Earlier in this task — ${middle.length} message(s) summarized to fit the context window]\n${summaryText}`,
  };
  return [...pruned.slice(0, head), summaryMessage, ...tail];
}
