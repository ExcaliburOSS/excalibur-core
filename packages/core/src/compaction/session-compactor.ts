import type { ChatMessage } from '@excalibur/model-gateway';
import type { SessionTurn } from '../sessions/session-store';
import { compact, compactAsync, reassembleContext } from './compactor';
import type { AsyncSummarizer } from './model-summarizer';
import { projectTranscript } from './transcript';
import type { CompactionConfig, CompactionRecord } from './types';

/** Inputs for {@link compactSession}. */
export interface CompactSessionOptions {
  config: CompactionConfig;
  /** The active model's context window (tokens); compaction triggers near it. */
  contextWindow: number;
  /** Turn ids to preserve verbatim (@file/#symbol pins, blocking claims). */
  pinnedIds?: ReadonlySet<string>;
  model?: string;
  locale?: string;
  /** Manual force (compact now, bypassing the budget gate). */
  force?: boolean;
}

/**
 * Compacts a session's transcript: projects the stable-id turns, runs the
 * compaction engine, and returns the {@link CompactionRecord} to persist — or
 * `null` when nothing needs compacting (under budget or disabled). The caller
 * persists it via `SessionStore.appendCompaction`.
 */
export function compactSession(
  turns: ReadonlyArray<SessionTurn>,
  options: CompactSessionOptions,
): CompactionRecord | null {
  const transcript = projectTranscript(turns, options.pinnedIds);
  return compact(transcript, {
    config: options.config,
    contextWindow: options.contextWindow,
    force: options.force ?? false,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
  });
}

/**
 * The async sibling of {@link compactSession}: same projection + engine, but a
 * model-backed {@link AsyncSummarizer} produces the summary (M2 real-model
 * path). Returns `null` when nothing needs compacting. The caller should catch
 * a thrown summarizer failure and fall back to {@link compactSession} (offline)
 * so compaction still happens.
 */
export async function compactSessionAsync(
  turns: ReadonlyArray<SessionTurn>,
  options: CompactSessionOptions & { summarize: AsyncSummarizer },
): Promise<CompactionRecord | null> {
  const transcript = projectTranscript(turns, options.pinnedIds);
  return compactAsync(transcript, {
    config: options.config,
    contextWindow: options.contextWindow,
    summarize: options.summarize,
    force: options.force ?? false,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
  });
}

/**
 * The REINJECTION primitive: builds the model context to feed the next turn (or
 * a resumed session) from the transcript + the latest compaction. With a record,
 * it is `[summary system message] + every turn from `firstKeptEntryId` onward`
 * (the verbatim tail plus everything added since the compaction); with no record
 * yet, it is the whole transcript as messages. The caller prepends the freshly
 * reconstructed system prompt + effective instructions on top.
 */
export function buildSessionSeed(
  turns: ReadonlyArray<SessionTurn>,
  latestRecord: CompactionRecord | null,
): ChatMessage[] {
  const { entries } = projectTranscript(turns);
  if (latestRecord === null) {
    return entries.map((entry) => ({ role: entry.role, content: entry.text }));
  }
  // The verbatim tail starts at the reload anchor (the first kept entry). The
  // anchor is user-aligned by planCompaction, so the tail is already user-first
  // WITHOUT skipping forward — the old forward-skip silently dropped kept
  // entries that were neither summarized nor reinjected.
  const anchorIndex =
    latestRecord.firstKeptEntryId === null
      ? entries.length
      : entries.findIndex((entry) => entry.id === latestRecord.firstKeptEntryId);
  const start = anchorIndex < 0 ? 0 : anchorIndex;
  // System / pinned entries the compaction preserved live BEFORE the anchor —
  // re-include them by id (matching the plan's kept set) so pins survive a
  // reload. The tail (anchor → end) is the verbatim recent context plus any
  // turns added since the compaction.
  const keptIds = new Set(latestRecord.details.keptEntryIds);
  const preservedPrefix = entries.slice(0, start).filter((entry) => keptIds.has(entry.id));
  return reassembleContext(latestRecord, [...preservedPrefix, ...entries.slice(start)]);
}
