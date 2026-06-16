/**
 * Context compaction (plan §"Compactación de contexto") — types.
 *
 * Compaction keeps a long session within a model's context window by replacing
 * older turns with a structured summary while preserving the recent tail, the
 * pinned set and (by reconstruction) system + effective instructions. It is
 * AUTOMATIC and config-only (no plugin SDK); the summary is emitted as the 24th
 * `compaction` ExcaliburEvent so replay/time-machine/fork keep working for free.
 */

/** `compaction:` config block (the only user-facing knobs). */
export interface CompactionConfig {
  /** Master switch (default true; disable with one flag). */
  enabled: boolean;
  /** Tokens held back from the window for the reply + headroom. */
  reserveTokens: number;
  /** Tokens of the most-recent tail preserved verbatim (cut only at turn limits). */
  keepRecentTokens: number;
  /** Which model summarizes: `active` | `cheap` | a concrete model id. */
  summarizerModel: string;
  /** Prune stale tool outputs before summarizing (cheaper, higher-signal). */
  pruneToolOutputs: boolean;
}

/** Field-tested defaults (plan §"Compactación de contexto"). */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  summarizerModel: 'cheap',
  pruneToolOutputs: true,
};

/** One projected transcript entry (a whole session turn — never split). */
export interface TranscriptEntry {
  /** Stable id `<sessionId>:<seq>` — the compaction cut point references it. */
  id: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** Estimated tokens for this entry. */
  tokens: number;
  /** Pinned entries are preserved verbatim regardless of age (@file/#symbol, claims). */
  pinned: boolean;
}

/** The session transcript projected over the stable-id turn stream. */
export interface SessionTranscript {
  entries: TranscriptEntry[];
  totalTokens: number;
}

/** The structured (non-free-text) summary the compactor produces. */
export interface StructuredSummary {
  objective: string;
  decisions: string[];
  filesTouched: string[];
  pending: string[];
  /** Counts of what was condensed, for transparency. */
  condensed: { entries: number; userTurns: number; assistantTurns: number };
}

/**
 * The persisted compaction result — the payload of the `compaction` event.
 * Because it carries `firstKeptEntryId`, reloading reconstructs the context as
 * `[summary] + entries from firstKeptEntryId onward` (+ the reconstructed
 * system/instructions), and the lossless raw stream still backs replay/fork.
 */
export interface CompactionRecord {
  /** Prose summary (redacted). */
  summary: string;
  structuredSummary: StructuredSummary;
  /** First entry kept verbatim; null when everything was summarized. */
  firstKeptEntryId: string | null;
  tokensBefore: number;
  tokensAfter: number;
  /** Model that summarized (or `default-mock` for the offline slice). */
  model: string;
  /** Locale the summary prose was written in (en/es …). */
  locale: string;
  details: { summarizedEntryIds: string[]; keptEntryIds: string[] };
  /** True when `redactSecrets` ran over the summary (always, in practice). */
  redacted: boolean;
}
