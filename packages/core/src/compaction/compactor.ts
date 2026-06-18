import {
  estimateTokens,
  redactSecrets,
  usableBudget,
  type ChatMessage,
} from '@excalibur/model-gateway';
import type {
  CompactionConfig,
  CompactionRecord,
  SessionTranscript,
  StructuredSummary,
  TranscriptEntry,
} from './types';

/** A planned compaction: a summarized PREFIX + a preserved set, with the cut. */
export interface CompactionPlan {
  /** Whether compaction is needed (over budget AND there is a prefix to summarize). */
  needed: boolean;
  /** First entry of the verbatim recent SUFFIX — the reload anchor. */
  firstKeptEntryId: string | null;
  /** Older entries to fold into the summary (excludes system/pinned). */
  summarize: TranscriptEntry[];
  /** Preserved verbatim = system/pinned from the prefix + the recent suffix. */
  kept: TranscriptEntry[];
  tokensBefore: number;
}

/** Index where the recent tail begins, accumulating from the end up to `keepRecentTokens`. */
function recentCutIndex(entries: ReadonlyArray<TranscriptEntry>, keepRecentTokens: number): number {
  let tail = 0;
  let cut = entries.length; // default: keep nothing (all is prefix)
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (tail >= keepRecentTokens) {
      break;
    }
    tail += entries[i]!.tokens;
    cut = i;
  }
  return cut;
}

/**
 * Plans a compaction as a clean prefix→summary / suffix→verbatim cut. The recent
 * tail (up to `keepRecentTokens`, cut only at a turn boundary) is preserved, and
 * system + pinned entries anywhere in the prefix are ALSO preserved verbatim
 * (instructions and pins must survive). Everything else in the prefix is folded
 * into the summary. Returns `needed: false` (keep everything) when disabled, when
 * under budget, or when there is nothing summarizable.
 */
export function planCompaction(
  transcript: SessionTranscript,
  config: CompactionConfig,
  contextWindow: number,
  force = false,
): CompactionPlan {
  const { entries } = transcript;
  const tokensBefore = transcript.totalTokens;
  const keepAll = (): CompactionPlan => ({
    needed: false,
    firstKeptEntryId: entries[0]?.id ?? null,
    summarize: [],
    kept: [...entries],
    tokensBefore,
  });
  // `force` (manual /compact) bypasses the enabled + budget gates and compacts
  // whatever is older than the recent tail now; otherwise honor both.
  if (!force) {
    if (!config.enabled) {
      return keepAll();
    }
    if (tokensBefore <= usableBudget({ contextWindow, reserveTokens: config.reserveTokens })) {
      return keepAll();
    }
  }

  let cut = recentCutIndex(entries, config.keepRecentTokens);
  // Align the kept tail to a USER-turn boundary by moving the cut FORWARD to the
  // next user turn. This keeps the tail user-first (Anthropic rejects an
  // assistant-leading turn) and makes the kept set match exactly what gets
  // reinjected on reload — no entry is silently dropped between "summarized" and
  // "kept" (the reinject no longer skips forward). The few leading assistant
  // entries of the natural tail are folded INTO the summary, never lost; moving
  // forward (not back) also avoids pulling the only summarizable content into
  // the kept tail and stalling compaction.
  while (cut < entries.length && entries[cut]?.role !== 'user') {
    cut += 1;
  }
  const suffix = entries.slice(cut);
  const prefix = entries.slice(0, cut);
  const preservedFromPrefix = prefix.filter((e) => e.role === 'system' || e.pinned);
  const summarize = prefix.filter((e) => !(e.role === 'system' || e.pinned));
  return {
    needed: summarize.length > 0,
    firstKeptEntryId: suffix[0]?.id ?? null,
    summarize,
    kept: [...preservedFromPrefix, ...suffix],
    tokensBefore,
  };
}

/**
 * The deterministic offline summarizer (the M-Shell slice's `default` strategy):
 * condenses entries into a structured + prose summary with NO model call, so the
 * whole compaction loop is demonstrable without a token. The real model-backed
 * summarizer (M2) implements the same `(entries) => {summary, structuredSummary}`
 * shape and routes via `summarizerModel`.
 */
export function defaultSummarizer(entries: ReadonlyArray<TranscriptEntry>): {
  summary: string;
  structuredSummary: StructuredSummary;
} {
  const userTurns = entries.filter((e) => e.role === 'user');
  const assistantTurns = entries.filter((e) => e.role === 'assistant');
  const objective = (userTurns[0]?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const structuredSummary: StructuredSummary = {
    objective,
    decisions: [],
    filesTouched: [],
    pending: [],
    condensed: {
      entries: entries.length,
      userTurns: userTurns.length,
      assistantTurns: assistantTurns.length,
    },
  };
  const summary =
    `Summary of ${entries.length} earlier turn(s)` +
    (objective.length > 0 ? `. Objective: ${objective}` : '') +
    `. (${userTurns.length} user / ${assistantTurns.length} assistant turns condensed; ` +
    `full detail remains in the run event stream.)`;
  return { summary, structuredSummary };
}

/** Options for {@link compact}; `summarize`/`redact` default to offline-safe behavior. */
export interface CompactOptions {
  config: CompactionConfig;
  contextWindow: number;
  model?: string;
  locale?: string;
  /** Summarizer strategy (defaults to the deterministic {@link defaultSummarizer}). */
  summarize?: (entries: ReadonlyArray<TranscriptEntry>) => {
    summary: string;
    structuredSummary: StructuredSummary;
  };
  /** Secret redactor applied to the summary (defaults to `redactSecrets`). */
  redact?: (text: string) => string;
  /** Manual force (bypass the enabled + budget gates); the recent tail is still preserved. */
  force?: boolean;
}

/** Options for {@link compactAsync}; `summarize` is an async (model-backed) strategy. */
export interface AsyncCompactOptions {
  config: CompactionConfig;
  contextWindow: number;
  model?: string;
  locale?: string;
  /** Async summarizer (e.g. the real-model one); awaited to produce the summary. */
  summarize: (entries: ReadonlyArray<TranscriptEntry>) => Promise<{
    summary: string;
    structuredSummary: StructuredSummary;
  }>;
  redact?: (text: string) => string;
  force?: boolean;
}

/**
 * Runs a compaction over a transcript, returning the {@link CompactionRecord} to
 * persist as the `compaction` event — or `null` when no compaction is needed.
 * The summary is always redacted (secrets never enter an event/session/memory).
 */
export function compact(
  transcript: SessionTranscript,
  options: CompactOptions,
): CompactionRecord | null {
  const plan = planCompaction(
    transcript,
    options.config,
    options.contextWindow,
    options.force ?? false,
  );
  if (!plan.needed) {
    return null;
  }
  const summarizer = options.summarize ?? defaultSummarizer;
  const { summary, structuredSummary } = summarizer(plan.summarize);
  return buildRecord(plan, summary, structuredSummary, options);
}

/**
 * The async sibling of {@link compact}: identical planning + record assembly,
 * but the summarizer is a model-backed `(entries) => Promise<{…}>` (the M2
 * real-model path, routed via `summarizerModel`). Returns `null` when no
 * compaction is needed. The caller is responsible for falling back to the
 * offline {@link compact} if the model summarizer throws.
 */
export async function compactAsync(
  transcript: SessionTranscript,
  options: AsyncCompactOptions,
): Promise<CompactionRecord | null> {
  const plan = planCompaction(
    transcript,
    options.config,
    options.contextWindow,
    options.force ?? false,
  );
  if (!plan.needed) {
    return null;
  }
  const { summary, structuredSummary } = await options.summarize(plan.summarize);
  return buildRecord(plan, summary, structuredSummary, options);
}

/** Shared tail of {@link compact}/{@link compactAsync}: redact + assemble the record. */
function buildRecord(
  plan: CompactionPlan,
  rawSummary: string,
  structuredSummary: StructuredSummary,
  options: { config: CompactionConfig; model?: string; locale?: string; redact?: (text: string) => string },
): CompactionRecord {
  const redact = options.redact ?? redactSecrets;
  const summary = redact(rawSummary);
  const keptTokens = plan.kept.reduce((sum, entry) => sum + entry.tokens, 0);
  return {
    summary,
    structuredSummary,
    firstKeptEntryId: plan.firstKeptEntryId,
    tokensBefore: plan.tokensBefore,
    tokensAfter: estimateTokens(summary) + keptTokens,
    model: options.model ?? options.config.summarizerModel,
    locale: options.locale ?? 'en',
    details: {
      summarizedEntryIds: plan.summarize.map((e) => e.id),
      keptEntryIds: plan.kept.map((e) => e.id),
    },
    redacted: true,
  };
}

/**
 * Reassembles the post-compaction context to reinject: the summary as a leading
 * system message, then the preserved/kept entries in order. The caller prepends
 * the freshly reconstructed system prompt + effective instructions on top (they
 * survive by reconstruction, not by living in the transcript).
 */
export function reassembleContext(
  record: CompactionRecord,
  kept: ReadonlyArray<TranscriptEntry>,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: `[compacted context]\n${record.summary}` },
  ];
  for (const entry of kept) {
    messages.push({ role: entry.role, content: entry.text });
  }
  return messages;
}
