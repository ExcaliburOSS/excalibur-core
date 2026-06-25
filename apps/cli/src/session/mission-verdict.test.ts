import { createEvent, type ExcaliburEventType } from '@excalibur/shared';
import { RunManager } from '@excalibur/core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVerdict } from './mission-run';

/**
 * Grounds the meta-orchestrator's gate decisions in the run's REAL events (M8
 * follow-up #44): a failed test / refuted claim / error must make the capability
 * `ok: false`, not rely on the model's prose.
 */
let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-verdict-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function seedRun(
  events: Array<{ type: ExcaliburEventType; payload: Record<string, unknown> }>,
): string {
  const rm = new RunManager(repo);
  const run = rm.createRun({ title: 'cap', workflow: 'structured-feature', autonomyLevel: 3 });
  for (const e of events) {
    rm.appendEvent(run.id, createEvent({ runId: run.id, type: e.type, payload: e.payload }));
  }
  return run.id;
}

describe('runVerdict (grounded capability outcome)', () => {
  it('ok when the run is clean', () => {
    const id = seedRun([
      { type: 'file_write', payload: { path: 'a.ts' } },
      { type: 'command_completed', payload: { exitCode: 0 } },
    ]);
    const v = runVerdict(repo, id);
    expect(v.ok).toBe(true);
  });

  it('FAILS on a failed test_result and reports it as a signal', () => {
    const id = seedRun([{ type: 'test_result', payload: { status: 'failed' } }]);
    const v = runVerdict(repo, id);
    expect(v.ok).toBe(false);
    expect(v.signals['testsPassed']).toBe(false);
  });

  it('FAILS on a refuted claim, a blocked verification, or an error', () => {
    expect(runVerdict(repo, seedRun([{ type: 'claim', payload: { status: 'refuted' } }])).ok).toBe(
      false,
    );
    expect(
      runVerdict(repo, seedRun([{ type: 'verification', payload: { blocked: true } }])).ok,
    ).toBe(false);
    const err = runVerdict(repo, seedRun([{ type: 'error', payload: { message: 'boom' } }]));
    expect(err.ok).toBe(false);
    expect(err.signals['errorCount']).toBe(1);
  });

  it('passes a passing test_result through as ok + signal', () => {
    const v = runVerdict(repo, seedRun([{ type: 'test_result', payload: { status: 'passed' } }]));
    expect(v.ok).toBe(true);
    expect(v.signals['testsPassed']).toBe(true);
  });

  it('degrades to ok for an unknown run', () => {
    expect(runVerdict(repo, 'run_nope').ok).toBe(true);
  });
});
