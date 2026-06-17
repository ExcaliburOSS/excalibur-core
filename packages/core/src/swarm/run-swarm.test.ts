import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import { runSwarm, type SwarmLane } from './run-swarm';

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

  it('captures a failing lane without aborting the swarm', async () => {
    const repo = initRepo();
    try {
      const result = await runSwarm(repo, [lane('ok'), lane('boom')], ({ lane: l, worktreePath }) => {
        if (l.id === 'boom') {
          throw new Error('lane exploded');
        }
        writeFileSync(join(worktreePath, 'ok.ts'), 'ok\n', 'utf8');
        return Promise.resolve(null);
      });
      const boom = result.lanes.find((l) => l.id === 'boom');
      expect(boom?.failed).toBe(true);
      expect(boom?.error).toContain('exploded');
      expect(result.mergedDiff).toContain('ok.ts'); // the healthy lane still merged
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
      await expect(runSwarm(empty, [lane('x')], () => Promise.resolve(null))).rejects.toThrow(/commit/);
    } finally {
      removeDir(empty);
    }
  });
});
