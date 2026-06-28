import { describe, expect, it } from 'vitest';
import type { TurnSummary } from '@excalibur/core';
import { renderTurnReceipt } from './turn-receipt';
import { createInteractiveCli } from '../test-utils';

/**
 * Offline tests for the "light" post-turn receipt renderer. Output is captured
 * via the non-interactive test Ui (NO_COLOR-friendly) and asserted on structure
 * — the receipt scales to the work and surfaces failures, never burying them.
 */

const now = new Date('2026-06-15T14:32:08.000Z');

function render(summary: TurnSummary): string {
  const cli = createInteractiveCli({ cwd: '/tmp' });
  renderTurnReceipt(cli.deps, summary, { now, model: 'opus-4.8' });
  return cli.stdout();
}

const base = {
  startedAt: '2026-06-15T14:30:20.000Z',
  completedAt: '2026-06-15T14:32:08.000Z',
  declined: 0,
};

describe('renderTurnReceipt (light)', () => {
  it('renders an action receipt: headline, metrics line, file list and an apply hint', () => {
    const out = render({
      ...base,
      runId: 'run_x',
      tier: 'action',
      narrative: 'Added a null-guard and a regression test.',
      changedFiles: [
        { path: 'src/billing/charge.ts', status: 'modified', insertions: 12, deletions: 3 },
        { path: 'src/billing/charge.test.ts', status: 'added', insertions: 28, deletions: 0 },
      ],
      checks: [{ label: 'tests', ok: true, detail: '142 passed' }],
      metrics: {
        files: 2,
        insertions: 40,
        deletions: 3,
        inputTokens: 9800,
        outputTokens: 2600,
        costCents: 4,
      },
      nextHint: { kind: 'apply', runId: 'run_x' },
    } as TurnSummary);

    expect(out).toContain('Added a null-guard and a regression test.');
    expect(out).toContain('2 files');
    expect(out).toContain('+40');
    expect(out).toContain('142 passed');
    expect(out).toContain('$0.04');
    expect(out).toContain('src/billing/charge.ts');
    expect(out).toContain('excalibur apply run_x');
    expect(out).toContain('/changes · /rewind');
  });

  it('omits the zero side of a per-file diffstat (added file shows only +N)', () => {
    const out = render({
      ...base,
      runId: 'run_x',
      tier: 'action',
      narrative: 'New file.',
      changedFiles: [{ path: 'src/new.ts', status: 'added', insertions: 28, deletions: 0 }],
      checks: [],
      metrics: {
        files: 1,
        insertions: 28,
        deletions: 0,
        inputTokens: 100,
        outputTokens: 50,
        costCents: 0,
      },
      nextHint: null,
    } as TurnSummary);
    expect(out).toContain('+28');
    expect(out).not.toContain('−0');
  });

  it('an answer receipt is just the narrative + a footer (no metrics block)', () => {
    const out = render({
      ...base,
      runId: 'run_x',
      tier: 'answer',
      narrative: 'It uses selectWorkflow to score intent.',
      changedFiles: [],
      checks: [],
      metrics: {
        files: 0,
        insertions: 0,
        deletions: 0,
        inputTokens: 1200,
        outputTokens: 320,
        costCents: 0,
      },
      nextHint: null,
    } as TurnSummary);
    expect(out).toContain('It uses selectWorkflow to score intent.');
    expect(out).not.toContain('files');
    expect(out).not.toContain('/changes · /rewind');
    expect(out).toContain('opus-4.8');
  });

  it('a failed receipt leads with the failing check and a fix hint', () => {
    const out = render({
      ...base,
      runId: 'run_x',
      tier: 'failed',
      narrative: 'Two tests still fail.',
      changedFiles: [
        { path: 'src/net/retry.ts', status: 'modified', insertions: 18, deletions: 6 },
      ],
      checks: [{ label: 'npm test', ok: false, detail: 'exit 1' }],
      metrics: {
        files: 1,
        insertions: 18,
        deletions: 6,
        inputTokens: 7200,
        outputTokens: 1900,
        costCents: 3,
      },
      nextHint: { kind: 'fix_failures' },
    } as TurnSummary);
    expect(out).toContain('npm test');
    expect(out).toContain('exit 1');
    // The hint is an honest STATUS, never a "you fix it" delegation (RUN-FIX-14).
    expect(out).toContain('still red');
  });
});
