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

/**
 * The CONTEXT BOUNDARY appended after the reinjected prior conversation (contamination fix):
 * a system instruction that marks every earlier turn as FINISHED background and pins the live
 * request to the user's NEXT message. Without it, a resumed / accumulated session fed the model
 * a PAST imperative request ("add retro subpages") as if it were current, and the agent
 * re-executed already-done work the user never re-asked for. Continuity is preserved (the prior
 * turns are still there as reference); only the licence to RE-EXECUTE them is removed.
 */
export const PRIOR_CONTEXT_BOUNDARY =
  'CONTEXT BOUNDARY — everything above this line is EARLIER conversation from this project, kept ' +
  'ONLY as background for continuity. Those requests were already handled and are FINISHED. Treat ' +
  "ONLY the user's NEXT message as the current request. Do NOT resume, repeat, continue, or " +
  're-execute any earlier request, task, plan or TODO from the prior context — not even if it looks ' +
  'unfinished — unless the next message explicitly asks you to. Use the prior context solely as ' +
  'reference for facts and decisions already made.';

/**
 * Appends the {@link PRIOR_CONTEXT_BOUNDARY} to a reinjected session seed so the model never
 * mistakes a past request for the current one. Returns the seed unchanged when it is empty (a
 * fresh session with no prior context needs no boundary). Pure — unit-testable.
 */
export function framePriorContext(seed: ReadonlyArray<ChatMessage>): ChatMessage[] {
  if (seed.length === 0) {
    return [...seed];
  }
  return [...seed, { role: 'system', content: PRIOR_CONTEXT_BOUNDARY }];
}
