import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, RunNotFoundError } from '@excalibur/shared';
import { makeTempDir, removeDir } from '../test-utils';
import { RunManager } from './run-manager';

describe('RunManager', () => {
  let repoRoot: string;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = makeTempDir();
    manager = new RunManager(repoRoot);
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('round-trips a run: create, events, artifacts, record updates', () => {
    const run = manager.createRun({
      title: 'Fix duplicated escrow release',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      methodology: 'fast-fix',
      model: 'mock',
      executionStyle: 'fast',
    });

    expect(run.id).toMatch(/^run_\d{8}_\d{6}$/);
    expect(run.dir).toBe(join(repoRoot, '.excalibur', 'runs', run.id));
    expect(existsSync(join(run.dir, 'run.json'))).toBe(true);
    expect(run.record.status).toBe('queued');
    expect(run.record.completedAt).toBeNull();

    const event = createEvent({
      runId: run.id,
      type: 'run_started',
      payload: { title: run.record.title },
    });
    manager.appendEvent(run.id, event);
    manager.appendEvent(
      run.id,
      createEvent({ runId: run.id, type: 'run_completed', payload: { status: 'completed' } }),
    );

    const events = manager.readEvents(run.id);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('run_started');
    expect(events[0]?.id).toBe(event.id);
    expect(events[1]?.type).toBe('run_completed');

    const artifactPath = manager.writeArtifact(run.id, 'summary.md', '# Summary\n');
    expect(readFileSync(artifactPath, 'utf8')).toBe('# Summary\n');

    const updated = manager.updateRecord(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    expect(updated.status).toBe('completed');
    expect(manager.getRun(run.id).record.status).toBe('completed');
  });

  it('links a run to a work item and finds it via runsForWorkItem', () => {
    const linked = manager.createRun({
      title: 'Implement WI-7',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      workItemId: 'WI-7',
    });
    manager.createRun({ title: 'unrelated', autonomyLevel: 1, workflow: 'assist' });
    expect(manager.getRun(linked.id).record.workItemId).toBe('WI-7');
    expect(manager.runsForWorkItem('WI-7').map((r) => r.id)).toEqual([linked.id]);
    expect(manager.runsForWorkItem('WI-999')).toEqual([]);
  });

  it('appends model calls as JSONL lines', () => {
    const run = manager.createRun({ title: 'T', autonomyLevel: 1, workflow: 'assist' });
    manager.appendModelCall(run.id, {
      provider: 'mock',
      model: 'mock-model',
      inputTokens: 10,
      outputTokens: 20,
      costCents: null,
      timestamp: new Date().toISOString(),
    });
    const lines = readFileSync(join(run.dir, 'model-calls.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ provider: 'mock', inputTokens: 10 });
  });

  it('lists runs in id order and resolves the latest run', () => {
    const first = manager.createRun({
      title: 'First',
      autonomyLevel: 2,
      workflow: 'propose-patch',
    });
    const second = manager.createRun({ title: 'Second', autonomyLevel: 3, workflow: 'fast-fix' });

    // Same-second creation must still produce unique, ordered ids.
    expect(first.id).not.toBe(second.id);

    const runs = manager.listRuns();
    expect(runs.map((run) => run.id)).toEqual([first.id, second.id].sort());
    expect(manager.latestRun()?.id).toBe([first.id, second.id].sort()[1]);
  });

  it('returns an empty event list for a run without events.jsonl', () => {
    const run = manager.createRun({ title: 'T', autonomyLevel: 0, workflow: 'review-only' });
    expect(manager.readEvents(run.id)).toEqual([]);
  });

  it('returns null for latestRun when no runs exist', () => {
    expect(manager.latestRun()).toBeNull();
    expect(manager.listRuns()).toEqual([]);
  });

  it('throws RunNotFoundError for unknown run ids', () => {
    expect(() => manager.getRun('run_19700101_000000')).toThrowError(RunNotFoundError);
    expect(() =>
      manager.appendEvent(
        'run_19700101_000000',
        createEvent({ runId: 'run_19700101_000000', type: 'error', payload: {} }),
      ),
    ).toThrowError(RunNotFoundError);
    expect(() => manager.writeArtifact('nope', 'a.md', 'x')).toThrowError(RunNotFoundError);
    expect(() => manager.updateRecord('nope', { status: 'failed' })).toThrowError(RunNotFoundError);
    try {
      manager.getRun('nope');
      expect.unreachable();
    } catch (error) {
      expect((error as RunNotFoundError).code).toBe('run_not_found');
    }
  });
});
