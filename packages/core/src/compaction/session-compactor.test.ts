import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SessionStore, type SessionTurn } from '../sessions/session-store';
import { DEFAULT_COMPACTION_CONFIG, type CompactionConfig } from './types';
import { buildSessionSeed, compactSession } from './session-compactor';

const T = (n: number): string => 'x'.repeat(n * 4); // estimateTokens = ceil(len/4)
function turn(seq: number, role: SessionTurn['role'], tokens: number, text?: string): SessionTurn {
  return {
    id: `s:${seq}`,
    seq,
    role,
    kind: 'message',
    text: text ?? T(tokens),
    at: '2026-06-16T12:00:00.000Z',
  };
}
const cfg = (over: Partial<CompactionConfig> = {}): CompactionConfig => ({
  ...DEFAULT_COMPACTION_CONFIG,
  ...over,
});

const bigTurns: SessionTurn[] = [
  turn(0, 'user', 200),
  turn(1, 'assistant', 200),
  turn(2, 'user', 200),
  turn(3, 'assistant', 200),
  turn(4, 'user', 10),
  turn(5, 'assistant', 10),
];

describe('compactSession', () => {
  it('returns null when under budget and not forced', () => {
    expect(compactSession(bigTurns, { config: cfg(), contextWindow: 100_000 })).toBeNull();
  });

  it('compacts when over budget', () => {
    const record = compactSession(bigTurns, {
      config: cfg({ reserveTokens: 50, keepRecentTokens: 20 }),
      contextWindow: 100,
      model: 'm',
    });
    expect(record).not.toBeNull();
    expect(record!.firstKeptEntryId).toBe('s:4');
    expect(record!.details.summarizedEntryIds).toEqual(['s:0', 's:1', 's:2', 's:3']);
  });

  it('force compacts even under budget (manual /compact)', () => {
    const record = compactSession(bigTurns, {
      config: cfg({ keepRecentTokens: 20 }),
      contextWindow: 100_000, // way under budget…
      force: true, // …but forced
    });
    expect(record).not.toBeNull();
    expect(record!.details.summarizedEntryIds.length).toBeGreaterThan(0);
  });
});

describe('buildSessionSeed (reinjection primitive)', () => {
  const convo: SessionTurn[] = [
    turn(0, 'user', 10, 'hi'),
    turn(1, 'assistant', 10, 'hello'),
    turn(2, 'user', 10, 'more'),
  ];

  it('with no compaction returns every turn as a message', () => {
    const seed = buildSessionSeed(convo, null);
    expect(seed.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(seed[1]).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('with a record leads with the summary, then the kept tail from firstKeptEntryId', () => {
    const turns: SessionTurn[] = [
      turn(0, 'user', 200),
      turn(1, 'assistant', 200),
      turn(2, 'user', 200),
      turn(3, 'assistant', 10),
    ];
    const record = compactSession(turns, {
      config: cfg({ reserveTokens: 50, keepRecentTokens: 10 }),
      contextWindow: 100,
    })!;
    const seed = buildSessionSeed(turns, record);
    expect(seed[0]!.role).toBe('system');
    expect(seed[0]!.content).toContain('compacted context');
    // Only the verbatim tail (from the anchor) follows the summary.
    expect(seed.length).toBeLessThan(turns.length + 1);
  });

  it('reinjects a user-first tail and never drops a kept entry', () => {
    // 6 alternating 200-token turns; the recent-tail cut lands on an ASSISTANT
    // turn (s:3), which the OLD code skipped forward over — silently dropping a
    // kept entry. Now the plan moves the anchor forward to the next USER turn
    // (s:4), folding s:3 into the summary, and the reinject keeps everything.
    const turns: SessionTurn[] = [
      turn(0, 'user', 200),
      turn(1, 'assistant', 200),
      turn(2, 'user', 200),
      turn(3, 'assistant', 200),
      turn(4, 'user', 200),
      turn(5, 'assistant', 200),
    ];
    const record = compactSession(turns, {
      config: cfg({ reserveTokens: 50, keepRecentTokens: 500 }),
      contextWindow: 100,
    })!;
    // Anchor is user-aligned (s:4), and the dropped-prone assistant s:3 is in
    // the SUMMARY (folded in), not lost.
    expect(record.firstKeptEntryId).toBe('s:4');
    expect(record.details.summarizedEntryIds).toContain('s:3');
    expect(record.details.keptEntryIds).toEqual(['s:4', 's:5']);

    const seed = buildSessionSeed(turns, record);
    expect(seed[0]!.role).toBe('system'); // the summary
    expect(seed[1]!.role).toBe('user'); // user-first tail (never assistant-leading)
    // Exactly summary + the two kept tail entries — nothing dropped, none extra.
    expect(seed).toHaveLength(3);
    expect(seed.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });
});

describe('SessionStore compaction persistence', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'excalibur-sess-compact-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('append/load/latest round-trips compaction records', () => {
    const store = new SessionStore(tmp);
    const session = store.createSession({ title: 't', repoRoot: tmp });
    expect(store.loadCompactions(session.id)).toEqual([]);
    expect(store.latestCompaction(session.id)).toBeNull();

    const record = compactSession(bigTurns, {
      config: cfg({ reserveTokens: 50, keepRecentTokens: 20 }),
      contextWindow: 100,
    })!;
    store.appendCompaction(session.id, record);
    expect(store.loadCompactions(session.id)).toHaveLength(1);
    expect(store.latestCompaction(session.id)?.firstKeptEntryId).toBe('s:4');
  });
});
