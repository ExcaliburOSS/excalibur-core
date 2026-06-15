import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, type ExcaliburEvent } from '@excalibur/shared';
import { RunManager } from '@excalibur/core';
import { createInteractiveCli, createTestCli, makeTempRepo, removeDir } from '../test-utils';
import { runScrubber } from '../lib/replay-scrubber';

/**
 * End-to-end tests for `excalibur fork` and `excalibur undo` (time-machine T2).
 * `makeTempRepo()` already gives a real git repo with a base commit (a worktree
 * needs one); the mock gateway drives the suffix. The fork reconstructs an
 * isolated worktree + a replayable child run; undo reverse-applies a run's
 * changes with a pre-flight safety gate.
 */

function initRepo(): string {
  return makeTempRepo();
}

/** A new-file diff (applies onto any tree, reverses cleanly). */
const GUARD_DIFF = [
  'diff --git a/src/guard.ts b/src/guard.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/guard.ts',
  '@@ -0,0 +1,1 @@',
  '+export const guard = true;',
].join('\n');

function seedRun(repo: string, diff: string): string {
  const manager = new RunManager(repo);
  const run = manager.createRun({
    title: 'add a guard',
    autonomyLevel: 4,
    workflow: 'conversation',
    methodology: null,
    model: 'mock',
    executionStyle: 'team_default',
  });
  const events: ExcaliburEvent[] = [
    createEvent({ runId: run.id, type: 'run_started', payload: { title: 'add a guard' } }),
    createEvent({ runId: run.id, type: 'model_call', payload: { model: 'mock', content: 'Adding a guard.', inputTokens: 500, outputTokens: 120, costCents: 2 } }),
    createEvent({ runId: run.id, type: 'tool_call', payload: { tool: 'apply_patch', arguments: { diff } } }),
    createEvent({ runId: run.id, type: 'patch_applied', payload: { tool: 'apply_patch', ok: true, simulated: false, diff, filesAffected: ['src/guard.ts'] } }),
    createEvent({ runId: run.id, type: 'assistant_message', payload: { content: 'Done.' } }),
  ];
  for (const event of events) {
    manager.appendEvent(run.id, event);
  }
  manager.updateRecord(run.id, { status: 'completed', completedAt: new Date().toISOString() });
  return run.id;
}

describe('excalibur fork', () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
  });
  afterEach(() => removeDir(repo));

  it('forks a run: reconstructs the worktree, copies the cached prefix, records provenance', async () => {
    const srcRunId = seedRun(repo, GUARD_DIFF);
    const cli = createTestCli({ cwd: repo });

    // Fork after the patch (step 4, 1-based) with a new instruction.
    await cli.run('fork', srcRunId, 'now add a comment too', '--at', '4');

    const stdout = cli.stdout();
    expect(stdout).toContain('fork of');
    expect(stdout).toContain('cached tokens');

    // A new, distinct run was created with fork provenance.
    const manager = new RunManager(repo);
    const forkRun = manager.listRuns().find((r) => r.id !== srcRunId);
    expect(forkRun).toBeDefined();
    expect(forkRun?.record.forkedFrom?.runId).toBe(srcRunId);
    expect(forkRun?.record.workflow).toBe('fork');

    // The cached prefix events were copied (marked cached) into the fork's log.
    const forkEvents = readFileSync(
      join(repo, '.excalibur', 'runs', forkRun?.id as string, 'events.jsonl'),
      'utf8',
    );
    expect(forkEvents).toContain('"cached":true');

    // The isolated worktree exists and was reconstructed (the patched file is there).
    const worktree = join(repo, '.excalibur', 'worktrees', forkRun?.id as string);
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(join(worktree, 'src', 'guard.ts'))).toBe(true);
  });

  it('refuses to fork a run that does not exist', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('fork', 'run_does_not_exist', 'do a thing')).rejects.toThrow();
  });
});

describe('excalibur undo', () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
  });
  afterEach(() => removeDir(repo));

  it('reverts the working tree by reverse-applying a run whose changes are present', async () => {
    // Put the run's change into the tree (as if it had been applied), then undo.
    writeFileSync(join(repo, 'src', 'guard.ts'), 'export const guard = true;\n', 'utf8');
    const srcRunId = seedRun(repo, GUARD_DIFF);
    expect(existsSync(join(repo, 'src', 'guard.ts'))).toBe(true);

    const cli = createTestCli({ cwd: repo });
    await cli.run('undo', srcRunId, '--at', '1', '--yes');

    // The new file was reverse-applied away.
    expect(existsSync(join(repo, 'src', 'guard.ts'))).toBe(false);
    expect(cli.stdout()).toContain('reverted');
  });

  it('refuses (no mutation) when the run changes do not reverse-apply to the tree', async () => {
    // The tree does NOT contain guard.ts → the reverse pre-flight must fail.
    const srcRunId = seedRun(repo, GUARD_DIFF);
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('undo', srcRunId, '--at', '1', '--yes')).rejects.toThrow(/do not reverse-apply|reverse/i);
    // No partial damage: the committed file is untouched.
    expect(readFileSync(join(repo, 'src', 'service.ts'), 'utf8')).toContain('release');
  });
});

describe('replay scrubber f/u keys', () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
  });
  afterEach(() => removeDir(repo));

  /** Drives runScrubber with scripted single-line controls over the session reader. */
  async function scrub(repoRoot: string, runId: string, keys: string[]): Promise<ReturnType<typeof createInteractiveCli>> {
    const cli = createInteractiveCli({ cwd: repoRoot });
    for (const key of keys) {
      cli.send(key);
    }
    const editor = cli.deps.ui.openLineEditor();
    await runScrubber(cli.deps, runId, {
      question: (prompt: string): Promise<string | null> => editor.question(prompt),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    editor.close();
    return cli;
  }

  it('`f` forks from the cursor step — reconstructs the worktree + records provenance', async () => {
    const srcRunId = seedRun(repo, GUARD_DIFF);
    // `$` → last step (after the patch), `f` → fork, then the instruction, then quit.
    await scrub(repo, srcRunId, ['$', 'f', 'now add a comment', 'q']);

    const manager = new RunManager(repo);
    const forkRun = manager.listRuns().find((r) => r.id !== srcRunId);
    expect(forkRun?.record.forkedFrom?.runId).toBe(srcRunId);
    // The worktree was reconstructed to the cursor state (the patched file is there).
    expect(
      existsSync(join(repo, '.excalibur', 'worktrees', forkRun?.id as string, 'src', 'guard.ts')),
    ).toBe(true);
  });

  it('`u` reverts the working tree to the cursor (gated, confirmed)', async () => {
    // The run's change is present in the tree; undo at the base cursor removes it.
    writeFileSync(join(repo, 'src', 'guard.ts'), 'export const guard = true;\n', 'utf8');
    const srcRunId = seedRun(repo, GUARD_DIFF);
    // cursor starts at step 0 (base) → `u` reverts everything; `y` confirms.
    await scrub(repo, srcRunId, ['u', 'y', 'q']);

    expect(existsSync(join(repo, 'src', 'guard.ts'))).toBe(false);
  });

  it('`x` (not `f`) is the failure jump now that `f` means fork', async () => {
    const srcRunId = seedRun(repo, GUARD_DIFF);
    const cli = await scrub(repo, srcRunId, ['x', 'q']);
    // No fork run was created by the failure jump.
    const manager = new RunManager(repo);
    expect(manager.listRuns().filter((r) => r.id !== srcRunId)).toHaveLength(0);
    // The controls help advertises the new bindings.
    expect(cli.stdout()).toContain('f fork');
    expect(cli.stdout()).toContain('u undo');
  });
});
