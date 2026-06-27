import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, type ExcaliburEvent } from '@excalibur/shared';
import { makeTempDir, removeDir } from '../test-utils';
import { RunManager } from './run-manager';
import { loadReplay } from '../replay/replay';
import { buildTurnSummary, parseDiffStat, turnSummaryToMarkdown } from './turn-summary';

/**
 * Offline tests for the post-turn receipt model. Events are written through the
 * real RunManager on-disk contract and the deterministic summary is asserted —
 * tier classification, diffstat, checks, declined approvals and the next hint.
 */

const ADD_DIFF = [
  'diff --git a/src/billing/charge.test.ts b/src/billing/charge.test.ts',
  '--- /dev/null',
  '+++ b/src/billing/charge.test.ts',
  '@@ -0,0 +1,3 @@',
  '+import { charge } from "./charge";',
  '+test("guards empty cart", () => {});',
  '+// regression for the crash',
].join('\n');

const MOD_DIFF = [
  'diff --git a/src/billing/charge.ts b/src/billing/charge.ts',
  '--- a/src/billing/charge.ts',
  '+++ b/src/billing/charge.ts',
  '@@ -1,4 +1,5 @@',
  ' export function charge(cart) {',
  '-  return cart.total;',
  '+  if (!cart) return 0;',
  '+  return cart.total;',
  ' }',
].join('\n');

describe('parseDiffStat', () => {
  it('counts insertions/deletions and classifies status per file', () => {
    const files = parseDiffStat(`${ADD_DIFF}\n${MOD_DIFF}`);
    expect(files).toHaveLength(2);

    const added = files.find((f) => f.path === 'src/billing/charge.test.ts');
    expect(added?.status).toBe('added');
    expect(added?.insertions).toBe(3);
    expect(added?.deletions).toBe(0);

    const modified = files.find((f) => f.path === 'src/billing/charge.ts');
    expect(modified?.status).toBe('modified');
    expect(modified?.insertions).toBe(2);
    expect(modified?.deletions).toBe(1);
  });

  it('returns [] for an empty diff and never throws on a partial one', () => {
    expect(parseDiffStat('')).toEqual([]);
    expect(() => parseDiffStat('diff --git a/x b/x\n+orphan line')).not.toThrow();
  });
});

describe('buildTurnSummary', () => {
  let repoRoot: string;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = makeTempDir();
    manager = new RunManager(repoRoot);
  });

  afterEach(() => removeDir(repoRoot));

  function run(events: (runId: string) => ExcaliburEvent[], opts?: { complete?: boolean }) {
    const created = manager.createRun({
      title: 'task',
      autonomyLevel: 4,
      workflow: 'conversation',
      methodology: null,
      model: 'mock',
      executionStyle: 'team_default',
    });
    for (const event of events(created.id)) {
      manager.appendEvent(created.id, event);
    }
    if (opts?.complete !== false) {
      manager.updateRecord(created.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });
    }
    return buildTurnSummary(loadReplay(repoRoot, created.id));
  }

  it('classifies an action turn with diffstat, a passing check and an apply hint', () => {
    const summary = run((runId) => [
      createEvent({ runId, type: 'run_started', payload: { title: 'task' } }),
      createEvent({
        runId,
        type: 'model_call',
        payload: { model: 'mock', inputTokens: 900, outputTokens: 260, costCents: 4 },
      }),
      createEvent({
        runId,
        type: 'patch_generated',
        payload: {
          diff: `${ADD_DIFF}\n${MOD_DIFF}`,
          filesAffected: ['src/billing/charge.test.ts', 'src/billing/charge.ts'],
        },
      }),
      createEvent({
        runId,
        type: 'command_completed',
        payload: { command: 'npm test', exitCode: 0 },
      }),
      createEvent({
        runId,
        type: 'test_result',
        payload: { status: 'passed', passed: 142, total: 142 },
      }),
      createEvent({
        runId,
        type: 'assistant_message',
        payload: { content: 'Added a guard + test.' },
      }),
    ]);

    expect(summary.tier).toBe('action');
    expect(summary.narrative).toBe('Added a guard + test.');
    expect(summary.metrics.files).toBe(2);
    expect(summary.metrics.insertions).toBe(5);
    expect(summary.metrics.deletions).toBe(1);
    expect(summary.metrics.inputTokens).toBe(900);
    expect(summary.metrics.costCents).toBe(4);
    expect(summary.checks.some((c) => c.label === 'tests' && c.ok)).toBe(true);
    expect(summary.nextHint).toEqual({ kind: 'apply', runId: summary.runId });
  });

  it('classifies a failed turn and points at the failing checks', () => {
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'model_call',
        payload: { model: 'mock', inputTokens: 700, outputTokens: 190, costCents: 3 },
      }),
      createEvent({
        runId,
        type: 'patch_generated',
        payload: { diff: MOD_DIFF, filesAffected: ['src/billing/charge.ts'] },
      }),
      createEvent({
        runId,
        type: 'command_completed',
        payload: { command: 'npm test', exitCode: 1 },
      }),
      createEvent({ runId, type: 'test_result', payload: { status: 'failed' } }),
      createEvent({
        runId,
        type: 'assistant_message',
        payload: { content: 'Two tests still fail.' },
      }),
    ]);

    expect(summary.tier).toBe('failed');
    expect(summary.nextHint).toEqual({ kind: 'fix_failures' });
    expect(summary.checks.every((c) => c.label !== 'tests' || !c.ok)).toBe(true);
  });

  it('does NOT fail a successful turn over a backgrounded command (e.g. a dev server)', () => {
    // The bug: `python3 -m http.server &` exited non-zero and flipped a finished
    // landing page to a red "failed" turn. A backgrounded command is fire-and-
    // forget, not a verdict — the turn stays `action`, with no fix_failures hint.
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'patch_generated',
        payload: { diff: ADD_DIFF, filesAffected: ['src/billing/charge.test.ts'] },
      }),
      createEvent({
        runId,
        type: 'command_completed',
        payload: { command: 'python3 -m http.server 8765 &', exitCode: 1 },
      }),
      createEvent({
        runId,
        type: 'assistant_message',
        payload: { content: 'Landing page is up.' },
      }),
    ]);

    expect(summary.tier).toBe('action');
    expect(summary.nextHint).toEqual({ kind: 'apply', runId: summary.runId });
    expect(summary.checks).toHaveLength(0); // the backgrounded command is not a check
  });

  it('does NOT fail over a signal-terminated command (a server the harness killed)', () => {
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'patch_generated',
        payload: { diff: ADD_DIFF, filesAffected: ['src/billing/charge.test.ts'] },
      }),
      createEvent({
        runId,
        type: 'command_completed',
        payload: { command: 'npm run dev', exitCode: 143 }, // 128 + SIGTERM
      }),
      createEvent({ runId, type: 'assistant_message', payload: { content: 'done' } }),
    ]);

    expect(summary.tier).toBe('action');
    expect(summary.checks).toHaveLength(0);
  });

  it('keeps a real non-zero command as a failing verdict (a genuine build/test failure still fails)', () => {
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'patch_generated',
        payload: { diff: MOD_DIFF, filesAffected: ['src/billing/charge.ts'] },
      }),
      createEvent({
        runId,
        type: 'command_completed',
        payload: { command: 'npm run build', exitCode: 2 },
      }),
      createEvent({ runId, type: 'assistant_message', payload: { content: 'build broke' } }),
    ]);

    expect(summary.tier).toBe('failed');
    expect(summary.nextHint).toEqual({ kind: 'fix_failures' });
  });

  it('omits the "exit 0" detail on a passing command (a green ✓ already says it passed)', () => {
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'patch_generated',
        payload: { diff: MOD_DIFF, filesAffected: ['src/billing/charge.ts'] },
      }),
      createEvent({
        runId,
        type: 'command_completed',
        payload: { command: 'npm run build', exitCode: 0 },
      }),
      createEvent({ runId, type: 'assistant_message', payload: { content: 'built' } }),
    ]);

    const check = summary.checks.find((c) => c.label === 'npm run build');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toBeNull();
  });

  it('classifies an answer turn (no changes) with no next hint', () => {
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'model_call',
        payload: { model: 'mock', inputTokens: 300, outputTokens: 80, costCents: 0 },
      }),
      createEvent({
        runId,
        type: 'assistant_message',
        payload: { content: 'It uses selectWorkflow.' },
      }),
    ]);

    expect(summary.tier).toBe('answer');
    expect(summary.changedFiles).toHaveLength(0);
    expect(summary.nextHint).toBeNull();
  });

  it('marks a partial turn (truncated) and counts declined approvals', () => {
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'model_call',
        payload: { model: 'mock', inputTokens: 500, outputTokens: 120, costCents: 2 },
      }),
      createEvent({
        runId,
        type: 'policy_decision',
        payload: { kind: 'confirmation', decision: 'deny', tool: 'write_file' },
      }),
      createEvent({
        runId,
        type: 'assistant_message',
        payload: { content: 'Stopped early.', truncated: true },
      }),
    ]);

    expect(summary.tier).toBe('partial');
    expect(summary.declined).toBe(1);
  });

  it('recovers the file list from filesAffected when the diff is empty (mock)', () => {
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'model_call',
        payload: { model: 'mock', inputTokens: 400, outputTokens: 100, costCents: 1 },
      }),
      createEvent({
        runId,
        type: 'patch_generated',
        payload: { diff: '', filesAffected: ['src/a.ts', 'src/b.ts'] },
      }),
      createEvent({ runId, type: 'assistant_message', payload: { content: 'done' } }),
    ]);

    expect(summary.tier).toBe('action');
    expect(summary.changedFiles.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(summary.changedFiles.every((f) => f.insertions === 0 && f.deletions === 0)).toBe(true);
  });

  it('serializes to a summary.md with the narrative, changes and checks', () => {
    const summary = run((runId) => [
      createEvent({
        runId,
        type: 'patch_generated',
        payload: { diff: MOD_DIFF, filesAffected: ['src/billing/charge.ts'] },
      }),
      createEvent({
        runId,
        type: 'test_result',
        payload: { status: 'passed', passed: 1, total: 1 },
      }),
      createEvent({
        runId,
        type: 'assistant_message',
        payload: { content: 'Guarded the charge path.' },
      }),
    ]);
    const md = turnSummaryToMarkdown(summary);
    expect(md).toContain('Guarded the charge path.');
    expect(md).toContain('src/billing/charge.ts');
    expect(md).toContain('## Checks');
  });
});
