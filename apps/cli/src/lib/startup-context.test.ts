import { MemoryStore, savePlan, type LocalSession, type SessionTurn } from '@excalibur/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStartupContext } from './startup-context';

const t = (key: string, vars?: Record<string, string | number>): string =>
  vars === undefined ? key : `${key} ${JSON.stringify(vars)}`;

const messageTurn = {
  id: 't1',
  seq: 1,
  at: '2026-06-17T00:00:00.000Z',
  role: 'user',
  kind: 'message',
  text: 'hi',
} as SessionTurn;

/** A store stub exposing only what buildStartupContext needs. */
function fakeStore(
  sessions: LocalSession[],
  transcript: SessionTurn[] = [messageTurn],
) {
  return {
    listSessions: (): LocalSession[] => sessions,
    readTranscript: (): SessionTurn[] => transcript,
  };
}

function session(repoRoot: string): LocalSession {
  return {
    id: 'sess_prev',
    dir: join(repoRoot, '.excalibur/sessions/sess_prev'),
    metadata: { repoRoot, status: 'closed' } as LocalSession['metadata'],
  } as LocalSession;
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-startup-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('buildStartupContext (proactive startup intelligence)', () => {
  it('is empty in a pristine repo (no session, plan or memory)', () => {
    const ctx = buildStartupContext(t, repo, fakeStore([]));
    expect(ctx.lines).toEqual([]);
    expect(ctx.latest).toBeNull();
  });

  it('surfaces the active plan and remembered decisions, and returns the latest session', () => {
    savePlan(repo, { task: 'Refactor auth', planMarkdown: 'x', status: 'approved', planRunId: 'r1' });
    new MemoryStore(repo).capture({ type: 'decision', statement: 'Use pnpm here' });
    const prev = session(repo);
    const ctx = buildStartupContext(t, repo, fakeStore([prev]));
    const joined = ctx.lines.join('\n');
    expect(joined).toContain('repl.context-plan');
    expect(joined).toContain('Refactor auth');
    expect(joined).toContain('repl.context-memory');
    expect(ctx.latest).toBe(prev);
  });

  it('ignores a latest session from a DIFFERENT repo', () => {
    const other = { ...session(repo), metadata: { repoRoot: '/elsewhere', status: 'active' } } as LocalSession;
    const ctx = buildStartupContext(t, repo, fakeStore([other]));
    expect(ctx.latest).toBeNull();
  });

  it('skips a cancelled plan when choosing the active one', () => {
    savePlan(repo, { task: 'Abandoned idea', planMarkdown: 'x', status: 'cancelled', planRunId: 'r0' });
    const ctx = buildStartupContext(t, repo, fakeStore([]));
    expect(ctx.lines.join('\n')).not.toContain('Abandoned idea');
  });
});
