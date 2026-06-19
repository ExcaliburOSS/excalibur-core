import { describe, expect, it } from 'vitest';
import type { SessionTurn } from '@excalibur/core';
import { buildSessionLog, formatSessionLog } from './session-log';

/** A translator stub: echoes the key with any vars appended (deterministic). */
const t = (key: string, vars?: Record<string, string | number>): string =>
  vars === undefined ? key : `${key} ${JSON.stringify(vars)}`;

function turn(over: Partial<SessionTurn>): SessionTurn {
  return {
    role: 'assistant',
    kind: 'message',
    text: 't',
    timestamp: '2026-06-17T00:00:00.000Z',
    ...over,
  } as SessionTurn;
}

const fakeRead = {
  loadReplay: (_repo: string, runId: string) =>
    ({
      run: {
        id: runId,
        title: runId === 'run_1' ? 'Add multiply' : '',
        status: 'completed',
        model: 'kimi',
        startedAt: '2026-06-17T00:00:00.000Z',
        completedAt: '2026-06-17T00:01:00.000Z',
      },
      steps: [{}],
    }) as never,
  buildTurnSummary: () =>
    ({ metrics: { costCents: 4, files: 2, insertions: 5, deletions: 1 } }) as never,
};

describe('buildSessionLog', () => {
  it('collects distinct run refs from the transcript, in first-appearance order', () => {
    const transcript = [
      turn({ artifactRef: 'run_1' }),
      turn({ kind: 'status', role: 'system', text: 'x' }), // no ref → ignored
      turn({ artifactRef: 'run_2' }),
      turn({ artifactRef: 'run_1' }), // dup → ignored
    ];
    const entries = buildSessionLog('/repo', transcript, fakeRead);
    expect(entries.map((e) => e.runId)).toEqual(['run_1', 'run_2']);
    expect(entries[0]).toMatchObject({
      position: 1,
      title: 'Add multiply',
      costCents: 4,
      files: 2,
    });
    expect(entries[1]?.position).toBe(2);
  });
});

describe('formatSessionLog', () => {
  it('renders an empty notice when there are no runs', () => {
    expect(formatSessionLog([], t)).toEqual(['session-log.empty']);
  });

  it('renders a heading with run count + total cost, a footer, and the untitled fallback', () => {
    const entries = buildSessionLog(
      '/repo',
      [turn({ artifactRef: 'run_1' }), turn({ artifactRef: 'run_2' })],
      fakeRead,
    );
    const out = formatSessionLog(entries, t, new Date('2026-06-17T00:02:00.000Z')).join('\n');
    expect(out).toContain('session-log.heading'); // header present
    expect(out).toContain('"runs":2'); // both runs counted
    expect(out).toContain('session-log.footer');
    expect(out).toContain('session-log.untitled'); // run_2 had no title
  });
});
