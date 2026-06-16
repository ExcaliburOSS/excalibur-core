import { describe, expect, it } from 'vitest';
import type { SessionTurn } from '../sessions/session-store';
import { projectTranscript } from './transcript';
import { compact, defaultSummarizer, planCompaction, reassembleContext } from './compactor';
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from './types';

// estimateTokens = ceil(len/4); a 40-char text = exactly 10 tokens.
const T = (n: number): string => 'x'.repeat(n * 4);

function turn(seq: number, role: SessionTurn['role'], tokens: number): SessionTurn {
  return {
    id: `s:${seq}`,
    seq,
    role,
    kind: 'message',
    text: T(tokens),
    at: '2026-06-16T12:00:00.000Z',
  };
}

// 6 turns × 10 tokens = 60 tokens total (user/assistant alternating).
const turns: SessionTurn[] = [
  turn(0, 'user', 10),
  turn(1, 'assistant', 10),
  turn(2, 'user', 10),
  turn(3, 'assistant', 10),
  turn(4, 'user', 10),
  turn(5, 'assistant', 10),
];

const cfg = (over: Partial<CompactionConfig> = {}): CompactionConfig => ({
  ...DEFAULT_COMPACTION_CONFIG,
  ...over,
});

describe('projectTranscript', () => {
  it('projects turns to entries with token estimates + total', () => {
    const t = projectTranscript(turns);
    expect(t.entries).toHaveLength(6);
    expect(t.totalTokens).toBe(60);
    expect(t.entries[0]).toMatchObject({
      id: 's:0',
      seq: 0,
      role: 'user',
      tokens: 10,
      pinned: false,
    });
  });

  it('marks pinned ids', () => {
    const t = projectTranscript(turns, new Set(['s:1']));
    expect(t.entries.find((e) => e.id === 's:1')?.pinned).toBe(true);
  });
});

describe('planCompaction', () => {
  it('keeps everything when under budget (no compaction needed)', () => {
    const t = projectTranscript(turns);
    const plan = planCompaction(t, cfg({ reserveTokens: 0, keepRecentTokens: 20 }), 1000); // usable 1000 > 60
    expect(plan.needed).toBe(false);
    expect(plan.summarize).toHaveLength(0);
    expect(plan.kept).toHaveLength(6);
  });

  it('keeps everything when disabled, even over budget', () => {
    const t = projectTranscript(turns);
    const plan = planCompaction(t, cfg({ enabled: false }), 10);
    expect(plan.needed).toBe(false);
    expect(plan.kept).toHaveLength(6);
  });

  it('cuts a prefix→summary / suffix→verbatim at a turn boundary when over budget', () => {
    const t = projectTranscript(turns);
    // usable = 100 − 50 = 50; total 60 > 50 → compact. keepRecent 20 → keep last 2 turns.
    const plan = planCompaction(t, cfg({ reserveTokens: 50, keepRecentTokens: 20 }), 100);
    expect(plan.needed).toBe(true);
    expect(plan.summarize.map((e) => e.id)).toEqual(['s:0', 's:1', 's:2', 's:3']);
    expect(plan.kept.map((e) => e.id)).toEqual(['s:4', 's:5']);
    expect(plan.firstKeptEntryId).toBe('s:4'); // the reload anchor (start of the verbatim suffix)
  });

  it('preserves system + pinned entries from the prefix verbatim', () => {
    const withSystem: SessionTurn[] = [turn(0, 'system', 10), ...turns.slice(1)];
    const t = projectTranscript(withSystem, new Set(['s:2']));
    const plan = planCompaction(t, cfg({ reserveTokens: 50, keepRecentTokens: 20 }), 100);
    // s:0 (system) and s:2 (pinned) are pulled out of the summary and kept.
    expect(plan.summarize.map((e) => e.id)).toEqual(['s:1', 's:3']);
    expect(plan.kept.map((e) => e.id)).toEqual(['s:0', 's:2', 's:4', 's:5']);
    expect(plan.firstKeptEntryId).toBe('s:4'); // suffix anchor unchanged by preserved prefix
  });
});

describe('defaultSummarizer', () => {
  it('is deterministic and reports condensed counts + the objective', () => {
    const entries = projectTranscript(turns.slice(0, 4)).entries; // 2 user / 2 assistant
    const a = defaultSummarizer(entries);
    const b = defaultSummarizer(entries);
    expect(a).toEqual(b); // deterministic
    expect(a.structuredSummary.condensed).toEqual({ entries: 4, userTurns: 2, assistantTurns: 2 });
    expect(a.summary).toContain('Summary of 4 earlier turn(s)');
  });
});

describe('compact + reassembleContext (the full loop, no token spent)', () => {
  it('returns null when no compaction is needed', () => {
    const t = projectTranscript(turns);
    expect(compact(t, { config: cfg(), contextWindow: 100000 })).toBeNull();
  });

  it('produces a record with the cut anchor + redaction + recomputed tokens', () => {
    // Large prefix turns (200 tok each) so condensing them genuinely shrinks the
    // context (a verbose summary of tiny turns can be larger — not an invariant).
    const big: SessionTurn[] = [
      turn(0, 'user', 200),
      turn(1, 'assistant', 200),
      turn(2, 'user', 200),
      turn(3, 'assistant', 200),
      turn(4, 'user', 10),
      turn(5, 'assistant', 10),
    ];
    const t = projectTranscript(big); // 820 tokens total
    const record = compact(t, {
      config: cfg({ reserveTokens: 50, keepRecentTokens: 20 }),
      contextWindow: 100,
      model: 'default-mock',
    });
    expect(record).not.toBeNull();
    expect(record!.firstKeptEntryId).toBe('s:4');
    expect(record!.tokensBefore).toBe(820);
    expect(record!.details.summarizedEntryIds).toEqual(['s:0', 's:1', 's:2', 's:3']);
    expect(record!.details.keptEntryIds).toEqual(['s:4', 's:5']);
    expect(record!.redacted).toBe(true);
    // 800 tokens of prefix → a ~tens-of-tokens summary + 20 kept ≪ 820 before.
    expect(record!.tokensAfter).toBeLessThan(record!.tokensBefore);
  });

  it('redacts secrets out of the summary', () => {
    const leaky: SessionTurn[] = [
      { ...turn(0, 'user', 0), text: 'use key sk-ABCDEF1234567890ABCDEF1234567890 to call it' },
      turn(1, 'assistant', 10),
      turn(2, 'user', 10),
      turn(3, 'assistant', 10),
    ];
    const t = projectTranscript(leaky);
    const record = compact(t, {
      config: cfg({ reserveTokens: 50, keepRecentTokens: 10 }),
      contextWindow: 30,
    });
    expect(record).not.toBeNull();
    expect(record!.summary).not.toContain('sk-ABCDEF1234567890ABCDEF1234567890');
  });

  it('reassembles [summary system message] + kept entries in order', () => {
    const t = projectTranscript(turns);
    const plan = planCompaction(t, cfg({ reserveTokens: 50, keepRecentTokens: 20 }), 100);
    const record = compact(t, {
      config: cfg({ reserveTokens: 50, keepRecentTokens: 20 }),
      contextWindow: 100,
    })!;
    const messages = reassembleContext(record, plan.kept);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('compacted context');
    expect(messages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant']); // s:4 user, s:5 assistant
    expect(messages).toHaveLength(3);
  });
});
