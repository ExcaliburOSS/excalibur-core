import { estimateTokens } from '@excalibur/model-gateway';
import type { SessionTurn } from '../sessions/session-store';
import type { SessionTranscript, TranscriptEntry } from './types';

/**
 * Projects the stable-id session turn stream into a {@link SessionTranscript}
 * with per-entry token estimates. Each turn is a whole entry (compaction cuts
 * only at entry boundaries, never mid-turn). `pinnedIds` marks entries that must
 * survive compaction verbatim (@file/#symbol pins, blocking claims).
 */
export function projectTranscript(
  turns: ReadonlyArray<SessionTurn>,
  pinnedIds: ReadonlySet<string> = new Set(),
): SessionTranscript {
  const entries: TranscriptEntry[] = [];
  let totalTokens = 0;
  for (const turn of turns) {
    const tokens = estimateTokens(turn.text);
    totalTokens += tokens;
    entries.push({
      id: turn.id,
      seq: turn.seq,
      role: turn.role,
      text: turn.text,
      tokens,
      pinned: pinnedIds.has(turn.id),
    });
  }
  return { entries, totalTokens };
}
