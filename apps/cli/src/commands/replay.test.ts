import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunManager } from '@excalibur/core';
import { createEvent, type ExcaliburEvent } from '@excalibur/shared';
import { runInteractiveSession } from '../session/repl';
import { createInteractiveCli, createTestCli, makeTempRepo, removeDir } from '../test-utils';

/**
 * Offline tests for the time-machine (`excalibur replay` + `/replay`). A run with
 * a known event sequence (including a failed test) is built directly through
 * RunManager, then driven via:
 *   - `--print` (non-TTY): the static linear summary of every step;
 *   - `--at <n>` (non-TTY): the reconstructed state at one step;
 *   - the interactive scrubber via scripted stdin (n,n,x → failure; ? → mock
 *     explanation; pin → annotate; q → quit);
 *   - `/replay` inside a session.
 * No real model/network — the zero-config mock provider supplies the explanation.
 */

const SAMPLE_DIFF = [
  '--- /dev/null',
  '+++ b/src/release.ts',
  '@@ -0,0 +1,2 @@',
  '+export const released = true;',
  '+// idempotency guard',
].join('\n');

const PHASE_IMPL = 'phase_impl';
const PHASE_VERIFY = 'phase_verify';

const repo = makeTempRepo();
let runId: string;

beforeAll(() => {
  const manager = new RunManager(repo);
  const run = manager.createRun({
    title: 'Fix duplicated release',
    autonomyLevel: 4,
    workflow: 'structured-feature',
    methodology: null,
    model: 'mock-model',
    executionStyle: 'structured',
  });
  runId = run.id;

  const events: ExcaliburEvent[] = [
    createEvent({ runId, type: 'run_started', payload: { title: 'Fix duplicated release' } }),
    createEvent({
      runId,
      type: 'phase_started',
      payload: { name: 'Implement', type: 'agent_work' },
      phaseId: PHASE_IMPL,
    }),
    createEvent({
      runId,
      type: 'model_call',
      payload: {
        model: 'mock-model',
        kind: 'patch',
        inputTokens: 1200,
        outputTokens: 340,
        costCents: 5,
      },
      phaseId: PHASE_IMPL,
    }),
    createEvent({
      runId,
      type: 'file_write',
      payload: { path: 'src/release.ts', diff: SAMPLE_DIFF },
      phaseId: PHASE_IMPL,
    }),
    createEvent({
      runId,
      type: 'phase_completed',
      payload: { name: 'Implement', status: 'completed' },
      phaseId: PHASE_IMPL,
    }),
    createEvent({
      runId,
      type: 'phase_started',
      payload: { name: 'Verify', type: 'command_group' },
      phaseId: PHASE_VERIFY,
    }),
    createEvent({
      runId,
      type: 'command_completed',
      payload: { command: 'npm test', exitCode: 0 },
      phaseId: PHASE_VERIFY,
    }),
    createEvent({
      runId,
      type: 'test_result',
      payload: { status: 'failed', commands: ['npm test'] },
      phaseId: PHASE_VERIFY,
    }),
    createEvent({
      runId,
      type: 'patch_generated',
      payload: { diff: SAMPLE_DIFF, filesAffected: ['src/release.ts'], artifact: 'diff.patch' },
      phaseId: PHASE_VERIFY,
    }),
    createEvent({
      runId,
      type: 'approval_requested',
      payload: { question: 'Apply the generated patch?' },
      phaseId: PHASE_VERIFY,
    }),
    createEvent({
      runId,
      type: 'phase_completed',
      payload: { name: 'Verify', status: 'completed' },
      phaseId: PHASE_VERIFY,
    }),
    createEvent({ runId, type: 'run_completed', payload: { status: 'completed' } }),
  ];
  for (const event of events) {
    manager.appendEvent(runId, event);
  }
  manager.updateRecord(runId, { status: 'completed', completedAt: new Date().toISOString() });
});

afterAll(() => removeDir(repo));

describe('excalibur replay — non-interactive (--print / --at)', () => {
  it('--print lists every step + the final cost summary', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('replay', runId, '--print');
    const stdout = cli.stdout();

    expect(stdout).toContain(`Rewind ${runId}`);
    expect(stdout).toContain('Fix duplicated release');
    expect(stdout).toContain('structured-feature');
    // A step per event, with summaries.
    expect(stdout).toContain('run started');
    expect(stdout).toContain('phase Implement started');
    expect(stdout).toContain('model call (1.2k in / 340 out)');
    expect(stdout).toContain('wrote src/release.ts');
    expect(stdout).toContain('tests → failed');
    expect(stdout).toContain('patch generated → src/release.ts');
    expect(stdout).toContain('run completed');
    // Cumulative cost ($0.05 from the one 5-cent model call).
    expect(stdout).toContain('Total cost: $0.05');
  });

  it('a non-TTY stdin auto-prints (no --print needed)', async () => {
    const cli = createTestCli({ cwd: repo }); // createTestCli is non-interactive
    await cli.run('replay', runId);
    expect(cli.stdout()).toContain('phase Verify');
  });

  it('defaults to the latest run when no id is given', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('replay', '--print');
    expect(cli.stdout()).toContain(`Rewind ${runId}`);
  });

  it('--at <n> prints the reconstructed state at step n (1-based)', async () => {
    const cli = createTestCli({ cwd: repo });
    // Step 9 (1-based) is the patch_generated event — the diff is reconstructable.
    await cli.run('replay', runId, '--at', '9');
    const stdout = cli.stdout();
    expect(stdout).toContain('step 9/12');
    expect(stdout).toContain('Verify');
    expect(stdout).toContain('patch generated → src/release.ts');
    expect(stdout).toContain('cost so far: $0.05');
    // The accumulated diff is shown at the cursor.
    expect(stdout).toContain('accumulated diff at cursor');
    expect(stdout).toContain('+export const released = true;');
  });

  it('rejects a non-numeric --at', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('replay', runId, '--at', 'abc')).rejects.toThrow();
  });
});

describe('excalibur replay — interactive scrubber (scripted stdin)', () => {
  it('n,n,x jumps to the failure; ? explains (mock); pin annotates; q quits', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('n'); // step 1 → 2
    cli.send('n'); // step 2 → 3
    cli.send('x'); // jump to the failed test_result (step 8, 1-based) — `f` is now fork
    cli.send('?'); // explain at the cursor (mock provider)
    cli.send('pin this is where tests break'); // annotate the current step
    cli.send('d'); // show the accumulated diff
    cli.send('q'); // quit

    const editor = cli.deps.ui.openLineEditor();
    const { runScrubber } = await import('../lib/replay-scrubber');
    await runScrubber(cli.deps, runId, {
      question: (prompt: string): Promise<string | null> => editor.question(prompt),
      now: () => '2026-06-14T12:00:00.000Z',
    });
    editor.close();

    const stdout = cli.stdout();
    // Header + controls.
    expect(stdout).toContain(`Rewind ${runId}`);
    expect(stdout).toContain('controls:');
    // The failure jump lands on the failed test_result (step 8/12).
    expect(stdout).toContain('step 8/12');
    expect(stdout).toContain('tests → failed');
    // Explain prints the mock provider's banner (offline, deterministic).
    expect(stdout).toContain('Why step 8?');
    expect(stdout).toContain('Mock provider (M1)');
    // Pin confirms + persists the annotation.
    expect(stdout).toContain('Pinned a note to step 8');
    // The diff view shows the reconstructed patch.
    expect(stdout).toContain('accumulated diff at cursor');
    expect(stdout).toContain('+// idempotency guard');

    // The annotation persisted to annotations.jsonl.
    const annotationsFile = join(repo, '.excalibur', 'runs', runId, 'annotations.jsonl');
    expect(existsSync(annotationsFile)).toBe(true);
    const annotation = JSON.parse(readFileSync(annotationsFile, 'utf8').trim());
    expect(annotation).toMatchObject({
      stepIndex: 7,
      note: 'this is where tests break',
      at: '2026-06-14T12:00:00.000Z',
    });
  });

  it('g <n> goes to a step and revisiting shows the inline annotation', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('g 8'); // go to step 8 (where the prior test pinned a note)
    cli.send('q');

    const editor = cli.deps.ui.openLineEditor();
    const { runScrubber } = await import('../lib/replay-scrubber');
    await runScrubber(cli.deps, runId, {
      question: (prompt: string): Promise<string | null> => editor.question(prompt),
      now: () => '2026-06-14T12:00:00.000Z',
    });
    editor.close();

    const stdout = cli.stdout();
    expect(stdout).toContain('step 8/12');
    // The annotation pinned by the previous test resurfaces inline.
    expect(stdout).toContain('this is where tests break');
  });
});

describe('/replay in a session', () => {
  it('opens the scrubber over the most recent run and quits cleanly', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send(`/replay ${runId}`);
    cli.send('e'); // jump to the next edit (a file_write/patch)
    cli.send('q'); // quit the scrubber → back to the session prompt
    cli.send('/exit'); // leave the session
    const code = await runInteractiveSession(cli.deps, {});

    expect(code).toBe(0);
    const stdout = cli.stdout();
    expect(stdout).toContain(`Rewind ${runId}`);
    expect(stdout).toContain('wrote src/release.ts');
    // Returned to the session and closed gracefully.
    expect(stdout).toContain('Goodbye.');
  });

  it('/help lists /rewind', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('/help');
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});
    expect(cli.stdout()).toContain('/rewind');
  });

  it('`rewind` (primary name) and `replay` (alias) both work', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('rewind', runId, '--print');
    expect(cli.stdout()).toContain(`Rewind ${runId}`);
    cli.reset();
    await cli.run('replay', runId, '--print'); // back-compat alias
    expect(cli.stdout()).toContain(`Rewind ${runId}`);
  });
});
