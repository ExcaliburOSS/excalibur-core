import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import { MemoryStore } from './memory-store';
import { buildMemoryContext, memoryContextSource } from './memory-context';
import { DEFAULT_CONFIDENCE } from './memory-node';

function store(now = '2026-06-17T00:00:00.000Z'): { repoRoot: string; store: MemoryStore } {
  const repoRoot = makeTempDir();
  return { repoRoot, store: new MemoryStore(repoRoot, { now: () => now }) };
}

describe('MemoryStore.capture', () => {
  it('stamps id/dates/defaults, redacts secrets, and persists', () => {
    const { repoRoot, store: s } = store();
    try {
      const node = s.capture({
        type: 'rejection',
        statement: 'Do not use an ORM here; the key is sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
        subjectPaths: ['src/escrow/charge.ts'],
        rationale: 'hot path — raw SQL is faster',
      });
      expect(node.id).toMatch(/^mem_/);
      expect(node.status).toBe('active');
      expect(node.evidenceCount).toBe(1);
      expect(node.confidence).toBe(DEFAULT_CONFIDENCE.rejection);
      expect(node.statement).toContain('[REDACTED]');
      expect(node.statement).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
      // Persisted + reloadable.
      expect(new MemoryStore(repoRoot).all()).toHaveLength(1);
    } finally {
      removeDir(repoRoot);
    }
  });
});

describe('MemoryStore.retrieve', () => {
  it('returns only nodes relevant to the query paths, ranked by confidence × recency', () => {
    const { repoRoot, store: s } = store('2026-06-17T00:00:00.000Z');
    try {
      // A directory-level node should match a file under it.
      s.capture({ type: 'risk', statement: 'escrow is sensitive', subjectPaths: ['src/escrow'] });
      s.capture({
        type: 'decision',
        statement: 'use zod for validation',
        subjectPaths: ['src/api/validate.ts'],
      });
      s.capture({ type: 'convention', statement: 'unrelated', subjectPaths: ['docs'] });

      const hits = new MemoryStore(repoRoot, { now: () => '2026-06-17T00:00:00.000Z' }).retrieve([
        'src/escrow/charge.ts',
      ]);
      expect(hits.map((n) => n.statement)).toEqual(['escrow is sensitive']); // only the related one
    } finally {
      removeDir(repoRoot);
    }
  });

  it('ranks a higher-confidence, more recent node first', () => {
    const repoRoot = makeTempDir();
    try {
      new MemoryStore(repoRoot, { now: () => '2026-01-01T00:00:00.000Z' }).capture({
        type: 'decision',
        statement: 'old low-confidence note',
        subjectPaths: ['src/pay'],
        confidence: 0.4,
      });
      new MemoryStore(repoRoot, { now: () => '2026-06-16T00:00:00.000Z' }).capture({
        type: 'rejection',
        statement: 'recent strong rejection',
        subjectPaths: ['src/pay'],
      });
      const hits = new MemoryStore(repoRoot, { now: () => '2026-06-17T00:00:00.000Z' }).retrieve([
        'src/pay/x.ts',
      ]);
      expect(hits[0]?.statement).toBe('recent strong rejection');
      expect(hits).toHaveLength(2);
    } finally {
      removeDir(repoRoot);
    }
  });

  it('honors the type filter and the limit', () => {
    const { repoRoot, store: s } = store();
    try {
      s.capture({ type: 'decision', statement: 'd1', subjectPaths: ['src'] });
      s.capture({ type: 'rejection', statement: 'r1', subjectPaths: ['src'] });
      const reloaded = new MemoryStore(repoRoot, { now: () => '2026-06-17T00:00:00.000Z' });
      expect(
        reloaded.retrieve(['src/x.ts'], { type: 'rejection' }).map((n) => n.statement),
      ).toEqual(['r1']);
      expect(reloaded.retrieve(['src/x.ts'], { limit: 1 })).toHaveLength(1);
    } finally {
      removeDir(repoRoot);
    }
  });
});

describe('MemoryStore knowledge-compounding loop (P2.12)', () => {
  it('REINFORCES a corroborating same-type capture instead of duplicating it', () => {
    const { repoRoot, store: s } = store();
    try {
      const first = s.capture({
        type: 'decision',
        statement: 'use postgres for the billing module',
        subjectPaths: ['src/billing'],
      });
      const second = s.capture({
        type: 'decision',
        statement: 'use postgres for the billing module',
        subjectPaths: ['src/billing'],
      });
      // Same id (reinforced revision), not a new node.
      expect(second.id).toBe(first.id);
      expect(second.evidenceCount).toBe(2);
      expect(second.confidence).toBeGreaterThan(first.confidence);
      // current() collapses to ONE node; the JSONL keeps both revisions (lossless).
      expect(s.current()).toHaveLength(1);
      expect(s.all().length).toBe(2);
    } finally {
      removeDir(repoRoot);
    }
  });

  it('SUPERSEDES a prior decision when a matching rejection lands on the same subject', () => {
    const { repoRoot, store: s } = store();
    try {
      const decision = s.capture({
        type: 'decision',
        statement: 'use an ORM for the payments module',
        subjectPaths: ['src/pay'],
      });
      const rejection = s.capture({
        type: 'rejection',
        statement: 'do not use an ORM for the payments module',
        subjectPaths: ['src/pay'],
      });
      const current = s.current();
      const supersededDecision = current.find((n) => n.id === decision.id);
      expect(supersededDecision?.status).toBe('superseded');
      expect(supersededDecision?.supersededById).toBe(rejection.id);
      expect(supersededDecision?.confidence).toBeLessThan(0.7); // halved from the prior
      // A future run no longer gets primed with the reversed decision.
      const hits = s.retrieve(['src/pay/charge.ts']);
      expect(hits.map((n) => n.id)).toEqual([rejection.id]);
    } finally {
      removeDir(repoRoot);
    }
  });

  it('does NOT reinforce two UNSCOPED (path-less) nodes just because their text is similar', () => {
    const { repoRoot, store: s } = store();
    try {
      // Similar (Jaccard ≥ 0.6) but different statements, both with NO subjectPaths.
      const a = s.capture({
        type: 'decision',
        statement: 'use feature flags for rollouts everywhere',
      });
      const b = s.capture({
        type: 'decision',
        statement: 'use feature flags for gradual rollouts',
      });
      // They are distinct facts, not a reinforcement — kept separate.
      expect(b.id).not.toBe(a.id);
      expect(b.evidenceCount).toBe(1);
      expect(s.current()).toHaveLength(2);
    } finally {
      removeDir(repoRoot);
    }
  });

  it('does NOT let a BROAD-ancestor rejection supersede a NARROW-file decision', () => {
    const { repoRoot, store: s } = store();
    try {
      const decision = s.capture({
        type: 'decision',
        statement: 'use an ORM in the charge module',
        subjectPaths: ['src/billing/charge.ts'],
      });
      // A rejection scoped to the whole billing dir must NOT wildcard-retire the
      // narrowly-scoped file decision (strict equal-path match for destructive ops).
      s.capture({
        type: 'rejection',
        statement: 'do not use an ORM in the charge module',
        subjectPaths: ['src/billing'],
      });
      expect(s.current().find((n) => n.id === decision.id)?.status).toBe('active');
    } finally {
      removeDir(repoRoot);
    }
  });

  it('honors an explicit supersedes target', () => {
    const { repoRoot, store: s } = store();
    try {
      const old = s.capture({
        type: 'convention',
        statement: 'tabs for indentation',
        subjectPaths: ['src'],
      });
      const fresh = s.capture({
        type: 'convention',
        statement: 'spaces for indentation everywhere',
        subjectPaths: ['src'],
        supersedes: old.id,
      });
      const superseded = s.current().find((n) => n.id === old.id);
      expect(superseded?.status).toBe('superseded');
      expect(superseded?.supersededById).toBe(fresh.id);
    } finally {
      removeDir(repoRoot);
    }
  });
});

describe('memoryContextSource / buildMemoryContext', () => {
  it('formats nodes as an injectable context source (null when empty)', () => {
    expect(memoryContextSource([])).toBeNull();
    const { repoRoot, store: s } = store();
    try {
      s.capture({
        type: 'rejection',
        statement: 'no ORM here',
        subjectPaths: ['src/escrow'],
        rationale: 'hot path',
      });
      const source = buildMemoryContext(repoRoot, ['src/escrow/charge.ts']);
      expect(source).not.toBeNull();
      expect(source?.title).toContain('Project memory');
      expect(source?.content).toContain('[rejection] no ORM here — hot path');
      expect(source?.content).toContain('src/escrow');
      expect(source?.precedence).toBe(6);
    } finally {
      removeDir(repoRoot);
    }
  });

  it('returns null for an unrelated query (does not pollute the turn)', () => {
    const { repoRoot, store: s } = store();
    try {
      s.capture({ type: 'decision', statement: 'about billing', subjectPaths: ['src/billing'] });
      expect(buildMemoryContext(repoRoot, ['src/auth/login.ts'])).toBeNull();
    } finally {
      removeDir(repoRoot);
    }
  });
});
