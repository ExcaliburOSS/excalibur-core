import { describe, expect, it } from 'vitest';
import {
  asAllocationSubtasks,
  chooseBuildShape,
  decomposeDeep,
  holdWhilePaused,
  parseFirstJsonObject,
  type SwarmSubtask,
} from './swarm';

/** A deterministic decompose oracle: maps a task string to a fixed decomposition,
 * so the G2 recursion is testable with NO model. Anything not in the table is
 * atomic (a single subtask = the task itself). */
function mockDecomposer(
  table: Record<string, Array<{ title: string; instruction: string; dependsOn?: number[] }>>,
): {
  chat(input: { messages: Array<{ role: string; content: string }> }): Promise<{ content: string }>;
} {
  return {
    chat: (input) => {
      const user = input.messages.find((m) => m.role === 'user')?.content ?? '';
      const subtasks = table[user] ?? [{ title: user.slice(0, 20), instruction: user }];
      return Promise.resolve({ content: JSON.stringify({ subtasks }) });
    },
  };
}

describe('holdWhilePaused (AO6 Pillar 3 — the pause gate loop)', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('returns immediately and never fires onPause when not paused', async () => {
    let paused = 0;
    let resumed = 0;
    await holdWhilePaused({
      isPaused: () => false,
      isAborted: () => false,
      sleep: noSleep,
      pollMs: 0,
      onPause: () => (paused += 1),
      onResume: () => (resumed += 1),
    });
    expect(paused).toBe(0);
    expect(resumed).toBe(0);
  });

  it('HOLDS while paused then resumes when the flag clears (onPause/onResume once)', async () => {
    let ticks = 0;
    let paused = 0;
    let resumed = 0;
    await holdWhilePaused({
      // paused for the first 3 polls, then cleared.
      isPaused: () => ticks < 3,
      isAborted: () => false,
      sleep: () => {
        ticks += 1;
        return Promise.resolve();
      },
      pollMs: 0,
      onPause: () => (paused += 1),
      onResume: () => (resumed += 1),
    });
    expect(paused).toBe(1);
    expect(resumed).toBe(1);
    expect(ticks).toBeGreaterThanOrEqual(3); // it actually held across polls
  });

  it('breaks the hold immediately when aborted (cancel beats pause)', async () => {
    let resumed = 0;
    await holdWhilePaused({
      isPaused: () => true, // would hold forever…
      isAborted: () => true, // …but a cancel is in effect
      sleep: noSleep,
      pollMs: 0,
      onPause: () => {
        throw new Error('must not pause when already aborted');
      },
      onResume: () => (resumed += 1),
    });
    expect(resumed).toBe(0);
  });
});

describe('chooseBuildShape (AO2 auto-orchestration decision)', () => {
  it('parallelizes a build with ≥2 independent subtasks in a git repo', () => {
    expect(chooseBuildShape({ isRepo: true, subtaskCount: 2 })).toBe('swarm');
    expect(chooseBuildShape({ isRepo: true, subtaskCount: 5 })).toBe('swarm');
  });

  it('runs sequentially when the task decomposed to a single workstream', () => {
    expect(chooseBuildShape({ isRepo: true, subtaskCount: 1 })).toBe('sequential');
    expect(chooseBuildShape({ isRepo: true, subtaskCount: 0 })).toBe('sequential');
  });

  it('never parallelizes outside a git repo (lanes need isolated worktrees)', () => {
    expect(chooseBuildShape({ isRepo: false, subtaskCount: 4 })).toBe('sequential');
    expect(chooseBuildShape({ isRepo: false, subtaskCount: 1 })).toBe('sequential');
  });
});

describe('parseFirstJsonObject (AO3b balanced-brace hardening)', () => {
  it('parses a clean JSON object', () => {
    expect(parseFirstJsonObject('{"subtasks":[]}')).toEqual({ subtasks: [] });
  });

  it('extracts the object from fenced output with trailing prose', () => {
    const out = 'Here you go:\n```json\n{"a":1,"b":{"c":2}}\n```\nHope that helps!';
    expect(parseFirstJsonObject(out)).toEqual({ a: 1, b: { c: 2 } });
  });

  it('stops at the first balanced object and ignores trailing junk that broke the greedy regex', () => {
    // A greedy /\{[\s\S]*\}/ would over-capture through the second brace block and fail.
    expect(parseFirstJsonObject('{"ok":true}\n\nNOTE: {not: valid json}')).toEqual({ ok: true });
  });

  it('handles braces inside strings without miscounting depth', () => {
    expect(parseFirstJsonObject('{"instruction":"use a regex like {2,3} here"}')).toEqual({
      instruction: 'use a regex like {2,3} here',
    });
  });

  it('returns null when there is no object', () => {
    expect(parseFirstJsonObject('no json here')).toBeNull();
    expect(parseFirstJsonObject('')).toBeNull();
  });
});

describe('asAllocationSubtasks', () => {
  it('maps decomposed subtasks to the allocator id/title pairs', () => {
    const subtasks: SwarmSubtask[] = [
      { id: 't1', title: 'Add the route', instruction: 'do A' },
      { id: 't2', title: 'Add the test', instruction: 'do B' },
    ];
    expect(asAllocationSubtasks(subtasks)).toEqual([
      { id: 't1', title: 'Add the route' },
      { id: 't2', title: 'Add the test' },
    ]);
  });
});

describe('decomposeDeep (G2 — recursive decomposition, no depth cap)', () => {
  // A substantial (>120 char) subsystem instruction → the oracle re-decomposes it.
  const AUTH_BIG =
    'Build the entire authentication subsystem: the user model, password hashing, the login and logout routes, session middleware, plus the integration tests that cover it all end to end.';

  it('re-decomposes a BIG subtask into leaves, preserving the hierarchy as deps', async () => {
    const chat = mockDecomposer({
      'build app': [
        { title: 'auth', instruction: AUTH_BIG }, // big → recurses
        { title: 'readme', instruction: 'write a short readme file' }, // small → leaf
      ],
      [AUTH_BIG]: [
        { title: 'models', instruction: 'create the auth user model' },
        { title: 'routes', instruction: 'create the login route', dependsOn: [1] }, // after models
      ],
    });

    const leaves = await decomposeDeep(chat, 'build app');

    // The flat decomposition was 2; recursion deepened `auth` into models+routes → 3 leaves.
    expect(leaves).toHaveLength(3);
    const ids = leaves.map((l) => l.id).sort();
    expect(ids).toEqual(['t1_t1', 't1_t2', 't2']); // t1(auth) expanded to t1_t1/t1_t2; t2(readme) stayed
    // The intra-subsystem ordering survives the flatten (routes depends on models).
    const routes = leaves.find((l) => l.id === 't1_t2');
    expect(routes?.dependsOn).toEqual(['t1_t1']);
    // The atomic sibling (readme) is a plain leaf with no deps.
    const readme = leaves.find((l) => l.id === 't2');
    expect(readme?.instruction).toBe('write a short readme file');
    expect(readme?.dependsOn).toBeUndefined();
  });

  it('leaves an already-atomic decomposition untouched (no needless recursion)', async () => {
    const chat = mockDecomposer({
      'small task': [
        { title: 'a', instruction: 'edit file a' },
        { title: 'b', instruction: 'edit file b' },
      ],
    });
    const leaves = await decomposeDeep(chat, 'small task');
    expect(leaves.map((l) => l.id)).toEqual(['t1', 't2']); // unchanged, both short → leaves
  });

  it('TERMINATES on a no-progress split (children not smaller than the parent)', async () => {
    // The oracle keeps returning 2 children that are NOT shorter — the progress
    // guard must treat the node as atomic instead of recursing forever.
    const BIG =
      'A long instruction that is more than one hundred and twenty characters so the looksBig probe fires and asks the oracle to split it.';
    const chat = mockDecomposer({
      'loop task': [{ title: 'x', instruction: BIG }],
      // children are LONGER than the parent → no progress → stop.
      [BIG]: [
        { title: 'x1', instruction: `${BIG} and even more text appended to make it longer #1` },
        { title: 'x2', instruction: `${BIG} and even more text appended to make it longer #2` },
      ],
    });
    const leaves = await decomposeDeep(chat, 'loop task');
    expect(leaves).toHaveLength(1); // did not explode; the big node stayed a single leaf
    expect(leaves[0]?.id).toBe('t1');
  });
});
