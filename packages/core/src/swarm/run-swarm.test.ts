import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import { runSwarm, runSwarmStaged, type SwarmLane } from './run-swarm';
import { existsSync } from 'node:fs';

function git(repo: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A temp repo with one base commit (`app.ts` with a known line). */
function initRepo(): string {
  const repo = makeTempDir();
  git(repo, 'init');
  git(repo, 'config', 'user.email', 't@t.co');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'app.ts'), 'export const VERSION = 1;\n', 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--no-gpg-sign', '-m', 'base');
  return repo;
}

const lane = (id: string, instruction = id): SwarmLane => ({ id, instruction });

describe('runSwarm', () => {
  it('fans out N lanes to isolated worktrees and fans in DISJOINT diffs cleanly', async () => {
    const repo = initRepo();
    try {
      const result = await runSwarm(
        repo,
        [lane('api'), lane('tests')],
        ({ lane: l, worktreePath, index }) => {
          // Each lane writes a DISTINCT new file in its own worktree.
          writeFileSync(join(worktreePath, `${l.id}.ts`), `// ${l.id} (lane ${index})\n`, 'utf8');
          return Promise.resolve({ wrote: `${l.id}.ts` });
        },
      );
      expect(result.conflicts).toEqual([]);
      expect(result.lanes).toHaveLength(2);
      expect(result.lanes.every((l) => !l.failed && l.diff.includes(`${l.id}.ts`))).toBe(true);
      // The merge contains BOTH lanes' new files.
      expect(result.mergedDiff).toContain('api.ts');
      expect(result.mergedDiff).toContain('tests.ts');
      // The user's working tree is untouched (worktrees were torn down).
      expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const VERSION = 1;\n');
    } finally {
      removeDir(repo);
    }
  });

  it('emits live per-lane progress (started + settled, with the failed flag)', async () => {
    const repo = initRepo();
    try {
      const events: string[] = [];
      await runSwarm(
        repo,
        [lane('ok'), lane('boom')],
        ({ lane: l, worktreePath }) => {
          if (l.id === 'boom') {
            throw new Error('lane failed on purpose');
          }
          writeFileSync(join(worktreePath, `${l.id}.ts`), `// ${l.id}\n`, 'utf8');
          return Promise.resolve({ wrote: `${l.id}.ts` });
        },
        {
          onLane: (p) => {
            events.push(`${p.id}:${p.phase}${p.failed === true ? ':failed' : ''}`);
          },
        },
      );
      expect(events).toContain('ok:started');
      expect(events).toContain('ok:settled');
      expect(events).toContain('boom:started');
      expect(events).toContain('boom:settled:failed');
    } finally {
      removeDir(repo);
    }
  });

  it('reports a lane whose diff CONFLICTS with the merge (same line, different edits)', async () => {
    const repo = initRepo();
    try {
      const result = await runSwarm(
        repo,
        [lane('bump-2'), lane('bump-3')],
        ({ lane: l, worktreePath }) => {
          const v = l.id === 'bump-2' ? 2 : 3;
          writeFileSync(join(worktreePath, 'app.ts'), `export const VERSION = ${v};\n`, 'utf8');
          return Promise.resolve(null);
        },
      );
      // Both lanes produced a diff, but they touch the same line → the 2nd conflicts.
      expect(result.lanes.every((l) => l.diff.length > 0)).toBe(true);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.id).toBe('bump-3');
      // The merge still holds the first lane's change cleanly.
      expect(result.mergedDiff).toContain('VERSION = 2');
    } finally {
      removeDir(repo);
    }
  });

  it('3-way HEALS a lane that conflicts only texturally (different lines of one file)', async () => {
    const repo = initRepo();
    try {
      // A small committed file so both lanes' diffs carry full context + the blob
      // the 3-way merge needs. Lane "top" edits line 1, "bottom" edits line 3 —
      // sequential apply makes the 2nd's context stale (a naive conflict), but the
      // 3-way merge reconstructs both edits.
      writeFileSync(join(repo, 'app.ts'), 'a\nb\nc\n', 'utf8');
      git(repo, 'add', '-A');
      git(repo, 'commit', '--no-gpg-sign', '-m', 'three');
      const result = await runSwarm(
        repo,
        [lane('top'), lane('bottom')],
        ({ lane: l, worktreePath }) => {
          const p = join(worktreePath, 'app.ts');
          const cur = readFileSync(p, 'utf8');
          writeFileSync(
            p,
            l.id === 'top' ? cur.replace('a\n', 'A\n') : cur.replace('c\n', 'C\n'),
            'utf8',
          );
          return Promise.resolve(null);
        },
      );
      // Without 3-way the second lane would land in `conflicts`; AO4d heals it.
      expect(result.conflicts).toEqual([]);
      expect(result.mergedDiff).toContain('+A');
      expect(result.mergedDiff).toContain('+C');
    } finally {
      removeDir(repo);
    }
  });

  it('captures a failing lane without aborting the swarm', async () => {
    const repo = initRepo();
    try {
      const result = await runSwarm(
        repo,
        [lane('ok'), lane('boom')],
        ({ lane: l, worktreePath }) => {
          if (l.id === 'boom') {
            throw new Error('lane exploded');
          }
          writeFileSync(join(worktreePath, 'ok.ts'), 'ok\n', 'utf8');
          return Promise.resolve(null);
        },
      );
      const boom = result.lanes.find((l) => l.id === 'boom');
      expect(boom?.failed).toBe(true);
      expect(boom?.error).toContain('exploded');
      expect(result.mergedDiff).toContain('ok.ts'); // the healthy lane still merged
    } finally {
      removeDir(repo);
    }
  });

  it('RE-DISPATCHES a transiently-failing lane up to maxAttempts (grader/rubric retry)', async () => {
    const repo = initRepo();
    try {
      const attempts = new Map<string, number>();
      const result = await runSwarm(
        repo,
        [lane('flaky'), lane('hopeless')],
        ({ lane: l, worktreePath }) => {
          const n = (attempts.get(l.id) ?? 0) + 1;
          attempts.set(l.id, n);
          if (l.id === 'flaky' && n < 2) {
            throw new Error('transient blip');
          }
          if (l.id === 'hopeless') {
            throw new Error('always fails');
          }
          writeFileSync(join(worktreePath, 'flaky.ts'), 'ok\n', 'utf8');
          return Promise.resolve(null);
        },
        { maxAttempts: 2 },
      );
      // 'flaky' failed once then SUCCEEDED on the retry; 'hopeless' exhausted both.
      expect(attempts.get('flaky')).toBe(2);
      expect(attempts.get('hopeless')).toBe(2);
      expect(result.lanes.find((l) => l.id === 'flaky')?.failed).toBe(false);
      expect(result.lanes.find((l) => l.id === 'hopeless')?.failed).toBe(true);
      expect(result.mergedDiff).toContain('flaky.ts');
    } finally {
      removeDir(repo);
    }
  });

  it('RESETS the worktree between attempts so partial edits never leak into the retry diff', async () => {
    const repo = initRepo();
    try {
      const attempts = new Map<string, number>();
      const result = await runSwarm(
        repo,
        [lane('dirty')],
        ({ lane: l, worktreePath }) => {
          const n = (attempts.get(l.id) ?? 0) + 1;
          attempts.set(l.id, n);
          if (n < 2) {
            // Attempt 1: write GARBAGE, then throw (partial state left behind).
            writeFileSync(join(worktreePath, 'garbage.ts'), 'BROKEN\n', 'utf8');
            throw new Error('crashed mid-edit');
          }
          // Attempt 2 runs against a freshly-reset tree → only good.ts should ship.
          writeFileSync(join(worktreePath, 'good.ts'), 'ok\n', 'utf8');
          return Promise.resolve(null);
        },
        { maxAttempts: 2 },
      );
      expect(attempts.get('dirty')).toBe(2);
      expect(result.lanes.find((l) => l.id === 'dirty')?.failed).toBe(false);
      // The reset cleaned attempt-1's garbage; the merged diff contains ONLY good.ts.
      expect(result.mergedDiff).toContain('good.ts');
      expect(result.mergedDiff).not.toContain('garbage.ts');
      expect(result.mergedDiff).not.toContain('BROKEN');
    } finally {
      removeDir(repo);
    }
  });

  it('GRADES lanes: revises a failing lane with feedback until it passes; drops one that never does', async () => {
    const repo = initRepo();
    try {
      const attempts = new Map<string, number>();
      const result = await runSwarm(
        repo,
        [lane('improve'), lane('doomed')],
        ({ lane: l, worktreePath, attempt, feedback }) => {
          attempts.set(l.id, attempt);
          // 'improve' writes a weak file first, then a GOOD one once it has
          // grader feedback (the revise loop); 'doomed' is always weak.
          const good = l.id === 'improve' && feedback !== undefined;
          writeFileSync(join(worktreePath, `${l.id}.ts`), good ? '// GOOD\n' : '// weak\n', 'utf8');
          return Promise.resolve({});
        },
        {
          maxAttempts: 2,
          grade: ({ diff }) =>
            Promise.resolve(
              diff.includes('GOOD') ? { pass: true } : { pass: false, feedback: 'make it GOOD' },
            ),
        },
      );
      // 'improve' failed attempt 1 (weak) → got feedback → passed attempt 2 (GOOD).
      const improve = result.lanes.find((l) => l.id === 'improve');
      expect(attempts.get('improve')).toBe(2);
      expect(improve?.failed).toBe(false);
      expect(improve?.attempts).toBe(2);
      expect(improve?.grade?.pass).toBe(true);
      // 'doomed' never met the rubric across both attempts → failed + EXCLUDED.
      const doomed = result.lanes.find((l) => l.id === 'doomed');
      expect(doomed?.failed).toBe(true);
      expect(doomed?.error).toContain('rubric not met');
      expect(result.mergedDiff).toContain('improve.ts');
      expect(result.mergedDiff).not.toContain('doomed.ts');
    } finally {
      removeDir(repo);
    }
  });

  it('respects the concurrency cap (never more lanes in flight than allowed)', async () => {
    const repo = initRepo();
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      await runSwarm(
        repo,
        [lane('a'), lane('b'), lane('c'), lane('d')],
        async ({ worktreePath, lane: l }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          writeFileSync(join(worktreePath, `${l.id}.ts`), 'x\n', 'utf8');
          inFlight -= 1;
        },
        { maxConcurrency: 2 },
      );
      expect(maxInFlight).toBeLessThanOrEqual(2);
    } finally {
      removeDir(repo);
    }
  });

  it('returns empty for no lanes and requires a git repo with commits', async () => {
    const repo = initRepo();
    try {
      expect(await runSwarm(repo, [], () => Promise.resolve(null))).toEqual({
        lanes: [],
        mergedDiff: '',
        conflicts: [],
      });
    } finally {
      removeDir(repo);
    }
    const empty = makeTempDir();
    try {
      git(empty, 'init');
      await expect(runSwarm(empty, [lane('x')], () => Promise.resolve(null))).rejects.toThrow(
        /commit/,
      );
    } finally {
      removeDir(empty);
    }
  });
});

describe('runSwarmStaged (AO3c staged dependency-graph executor)', () => {
  it('rebases a dependent wave on the MERGED result of its predecessor', async () => {
    const repo = initRepo();
    try {
      // Wave 0 creates shared.ts; wave 1 must SEE it (proving the rebase) and
      // derives derived.ts from its contents.
      const result = await runSwarmStaged(
        repo,
        [[lane('base')], [lane('extend')]],
        ({ lane: l, worktreePath }) => {
          if (l.id === 'base') {
            writeFileSync(join(worktreePath, 'shared.ts'), 'export const base = 1;\n', 'utf8');
            return Promise.resolve(null);
          }
          // The dependent lane reads the predecessor's merged file from its base.
          const seen = existsSync(join(worktreePath, 'shared.ts'))
            ? readFileSync(join(worktreePath, 'shared.ts'), 'utf8').trim()
            : 'MISSING';
          writeFileSync(join(worktreePath, 'derived.ts'), `// saw: ${seen}\n`, 'utf8');
          return Promise.resolve(null);
        },
      );
      expect(result.conflicts).toEqual([]);
      expect(result.lanes.map((l) => l.id)).toEqual(['base', 'extend']);
      // The dependent lane SAW the predecessor's merged content (not MISSING).
      expect(result.mergedDiff).toContain('saw: export const base = 1;');
      expect(result.mergedDiff).toContain('shared.ts');
      expect(result.mergedDiff).toContain('derived.ts');
      // Working tree untouched.
      expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const VERSION = 1;\n');
    } finally {
      removeDir(repo);
    }
  });

  it('runs independent lanes within a single wave in parallel (flat-equivalent)', async () => {
    const repo = initRepo();
    try {
      const result = await runSwarmStaged(
        repo,
        [[lane('a'), lane('b')]],
        ({ lane: l, worktreePath }) => {
          writeFileSync(join(worktreePath, `${l.id}.ts`), `// ${l.id}\n`, 'utf8');
          return Promise.resolve(null);
        },
      );
      expect(result.conflicts).toEqual([]);
      expect(result.mergedDiff).toContain('a.ts');
      expect(result.mergedDiff).toContain('b.ts');
    } finally {
      removeDir(repo);
    }
  });

  it('returns empty for no waves and requires a git repo with commits', async () => {
    const repo = initRepo();
    try {
      expect(await runSwarmStaged(repo, [], () => Promise.resolve(null))).toEqual({
        lanes: [],
        mergedDiff: '',
        conflicts: [],
      });
    } finally {
      removeDir(repo);
    }
  });

  it('AO5-6: a RED per-wave gate REVERTS the wave so dependents base on the healthy tree', async () => {
    const repo = initRepo();
    try {
      const verifyCalls: number[] = [];
      const result = await runSwarmStaged(
        repo,
        [[lane('base')], [lane('extend')]],
        ({ lane: l, worktreePath }) => {
          if (l.id === 'base') {
            writeFileSync(join(worktreePath, 'shared.ts'), 'export const base = 1;\n', 'utf8');
            return Promise.resolve(null);
          }
          const seen = existsSync(join(worktreePath, 'shared.ts'))
            ? readFileSync(join(worktreePath, 'shared.ts'), 'utf8').trim()
            : 'MISSING';
          writeFileSync(join(worktreePath, 'derived.ts'), `// saw: ${seen}\n`, 'utf8');
          return Promise.resolve(null);
        },
        {
          // Fail wave 0 (revert it); pass wave 1.
          verifyWave: ({ waveIndex }) => {
            verifyCalls.push(waveIndex);
            return Promise.resolve(
              waveIndex === 0 ? { passed: false, revert: true, detail: 'red' } : { passed: true },
            );
          },
        },
      );
      expect(verifyCalls).toEqual([0, 1]); // gate fired at each wave boundary
      // Wave 0 reverted → its lane marked failed, shared.ts NOT in the merged diff.
      expect(result.lanes.find((l) => l.id === 'base')?.failed).toBe(true);
      expect(result.mergedDiff).not.toContain('shared.ts');
      // Wave 1 still ran, but on the REVERTED (original) base → saw MISSING.
      expect(result.mergedDiff).toContain('derived.ts');
      expect(result.mergedDiff).toContain('saw: MISSING');
    } finally {
      removeDir(repo);
    }
  });

  it('AO5-6: a GREEN per-wave gate is identical to no gate (dependents see the merge)', async () => {
    const repo = initRepo();
    try {
      const result = await runSwarmStaged(
        repo,
        [[lane('base')], [lane('extend')]],
        ({ lane: l, worktreePath }) => {
          if (l.id === 'base') {
            writeFileSync(join(worktreePath, 'shared.ts'), 'export const base = 1;\n', 'utf8');
            return Promise.resolve(null);
          }
          const seen = existsSync(join(worktreePath, 'shared.ts'))
            ? readFileSync(join(worktreePath, 'shared.ts'), 'utf8').trim()
            : 'MISSING';
          writeFileSync(join(worktreePath, 'derived.ts'), `// saw: ${seen}\n`, 'utf8');
          return Promise.resolve(null);
        },
        { verifyWave: () => Promise.resolve({ passed: true }) },
      );
      expect(result.mergedDiff).toContain('saw: export const base = 1;');
      expect(result.mergedDiff).toContain('shared.ts');
    } finally {
      removeDir(repo);
    }
  });

  it('AO5-6: a THROWING per-wave gate propagates (not swallowed like onLane)', async () => {
    const repo = initRepo();
    try {
      await expect(
        runSwarmStaged(
          repo,
          [[lane('a')]],
          ({ worktreePath }) => {
            writeFileSync(join(worktreePath, 'a.ts'), '// a\n', 'utf8');
            return Promise.resolve(null);
          },
          { verifyWave: () => Promise.reject(new Error('gate boom')) },
        ),
      ).rejects.toThrow('gate boom');
    } finally {
      removeDir(repo);
    }
  });
});
