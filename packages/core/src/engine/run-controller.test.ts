import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import { DEFAULT_PROVIDERS_CONFIG, ModelGateway } from '@excalibur/model-gateway';
import { DEFAULT_CONFIG, type ExcaliburConfig, type ExcaliburEvent } from '@excalibur/shared';
import { getDefaultWorkflow, type WorkflowDefinition } from '@excalibur/workflow-schema';
import { RunManager } from '../runs/run-manager';
import { makeTempDir, removeDir } from '../test-utils';
import { executeLocalRun } from './execute-local-run';
import { RunController } from './run-controller';

/**
 * The headless RunController + the engine's AbortSignal plumbing (P0.3a): start a
 * run, stream its events, answer an approval out-of-band, and cancel — the
 * primitives the programmable serve write surface + the ACP server build on. The
 * gateway is the offline mock; the native adapter is real.
 */

let repoRoot: string;
let gateway: ModelGateway;
const config: ExcaliburConfig = DEFAULT_CONFIG;

/** A one-required-human-approval workflow (reuses human-gated's valid shape). */
function approvalWorkflow(): WorkflowDefinition {
  const base = getDefaultWorkflow('human-gated');
  if (base === undefined) throw new Error('human-gated workflow missing');
  return {
    ...base,
    id: 'test-approval',
    name: 'Test Approval',
    phases: [
      { id: 'gate', name: 'Gate', type: 'human_approval', required: true, approval: 'required' },
    ],
  };
}

beforeEach(() => {
  repoRoot = makeTempDir();
  gateway = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
});

afterEach(() => {
  removeDir(repoRoot);
});

describe('executeLocalRun — abort signal', () => {
  it('ends a run "cancelled" when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const runManager = new RunManager(repoRoot);
    const definition = getDefaultWorkflow('review-only');
    const run = runManager.createRun({
      title: 'noop',
      autonomyLevel: 0,
      workflow: 'review-only',
      executionStyle: null,
    });
    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway,
      adapter: new NativeAgentAdapter(),
      config,
      signal: controller.signal,
    });
    expect(record.status).toBe('cancelled');
  });
});

describe('RunController', () => {
  it('starts a run, streams events, and tracks it in the registry', async () => {
    const rc = new RunController();
    const handle = await rc.startRun({
      repoRoot,
      task: 'Review the repository',
      gateway,
      config,
      workflow: 'review-only',
      catalog: [{ id: 'review-only', definition: getDefaultWorkflow('review-only')! }],
    });
    const events: ExcaliburEvent[] = [];
    handle.subscribe((e) => events.push(e));

    expect(rc.get(handle.runId)).toBe(handle);
    expect(rc.list()).toContain(handle.runId);

    const record = await handle.record;
    expect(record.status).toBe('completed');
    expect(handle.status()).toBe('completed');
    const types = events.map((e) => e.type);
    expect(types).toContain('run_started');
    expect(types).toContain('run_completed');
  });

  it('answers an approval out-of-band via approve()', async () => {
    const rc = new RunController();
    const handle = await rc.startRun({
      repoRoot,
      task: 'Gated task',
      gateway,
      config,
      workflow: 'test-approval',
      catalog: [{ id: 'test-approval', definition: approvalWorkflow() }],
    });
    // The run BLOCKS on the gate until we approve (the controller passes a
    // confirm bridge, so it never auto-approves).
    handle.subscribe((e) => {
      if (e.type === 'approval_requested') {
        handle.approve(true);
      }
    });
    const record = await handle.record;
    expect(record.status).toBe('completed');
  });

  it('cancel() unblocks a pending approval and ends the run cancelled', async () => {
    const rc = new RunController();
    const handle = await rc.startRun({
      repoRoot,
      task: 'Gated task to cancel',
      gateway,
      config,
      workflow: 'test-approval',
      catalog: [{ id: 'test-approval', definition: approvalWorkflow() }],
    });
    handle.subscribe((e) => {
      if (e.type === 'approval_requested') {
        // Cancelling must unblock the (about-to-be-)awaited approval, not hang.
        handle.cancel();
      }
    });
    const record = await handle.record;
    expect(record.status).toBe('cancelled');
  });
});
