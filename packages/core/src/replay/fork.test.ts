import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, type ExcaliburEvent } from '@excalibur/shared';
import { makeTempDir, removeDir } from '../test-utils';
import { RunManager } from '../runs/run-manager';
import {
  planFork,
  planUndo,
  reconstructConversationPrefix,
  restampEventsForFork,
} from './fork';
import { loadReplay } from './replay';

/**
 * Offline tests for fork-from-cache reconstruction. The conversation prefix MUST
 * be a valid message list (every assistant tool call answered by a tool result,
 * never a dangling call) even when the fork point lands mid-turn — a malformed
 * prefix would break a real provider. These tests assert that invariant plus the
 * worktree base diff, token/cost accounting and the undo plan.
 */

const DIFF = [
  'diff --git a/src/charge.ts b/src/charge.ts',
  '--- a/src/charge.ts',
  '+++ b/src/charge.ts',
  '@@ -1,2 +1,3 @@',
  ' export function charge(cart) {',
  '+  if (!cart) return 0;',
  '   return cart.total;',
].join('\n');

describe('fork-from-cache reconstruction', () => {
  let repoRoot: string;
  let manager: RunManager;
  let runId: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
    manager = new RunManager(repoRoot);
    const run = manager.createRun({
      title: 'Guard the charge path',
      autonomyLevel: 4,
      workflow: 'conversation',
      methodology: null,
      model: 'mock',
      executionStyle: 'team_default',
    });
    runId = run.id;
    const events: ExcaliburEvent[] = [
      createEvent({ runId, type: 'run_started', payload: { title: 'Guard the charge path' } }),
      // Turn 1: assistant narrates + reads a file → one paired tool call.
      createEvent({ runId, type: 'model_call', payload: { model: 'mock', content: "I'll read charge.ts.", inputTokens: 800, outputTokens: 200, costCents: 3 } }),
      createEvent({ runId, type: 'tool_call', payload: { tool: 'read_file', arguments: { path: 'src/charge.ts' } } }),
      createEvent({ runId, type: 'file_read', payload: { tool: 'read_file', ok: true, path: 'src/charge.ts', result: 'export function charge(cart) {\n  return cart.total;\n}' } }),
      // Turn 2: assistant edits → patch.
      createEvent({ runId, type: 'model_call', payload: { model: 'mock', content: 'Adding the guard.', inputTokens: 900, outputTokens: 260, costCents: 4 } }),
      createEvent({ runId, type: 'tool_call', payload: { tool: 'apply_patch', arguments: { diff: DIFF } } }),
      createEvent({ runId, type: 'patch_applied', payload: { tool: 'apply_patch', ok: true, simulated: false, result: 'applied', diff: DIFF, filesAffected: ['src/charge.ts'] } }),
      // Final answer.
      createEvent({ runId, type: 'model_call', payload: { model: 'mock', content: 'Done.', inputTokens: 300, outputTokens: 80, costCents: 1 } }),
      createEvent({ runId, type: 'assistant_message', payload: { content: 'Done — added the guard.' } }),
    ];
    for (const event of events) {
      manager.appendEvent(runId, event);
    }
  });

  afterEach(() => removeDir(repoRoot));

  function prefixAt(at: number) {
    return reconstructConversationPrefix(loadReplay(repoRoot, runId), at);
  }

  /** Every `tool` message must answer a preceding assistant tool call. */
  function assertValid(messages: ReturnType<typeof prefixAt>): void {
    const openIds = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const call of message.toolCalls) {
          openIds.add(call.id);
        }
      }
      if (message.role === 'tool') {
        expect(message.toolCallId).toBeDefined();
        expect(openIds.has(message.toolCallId as string)).toBe(true);
      }
    }
    // No assistant tool call is left unanswered.
    const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId));
    for (const message of messages) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const call of message.toolCalls) {
          expect(answered.has(call.id)).toBe(true);
        }
      }
    }
  }

  it('seeds the initial user task as the first message', () => {
    const prefix = prefixAt(0);
    expect(prefix[0]).toEqual({ role: 'user', content: 'Guard the charge path' });
  });

  it('reconstructs a full, valid prefix with paired tool calls + results', () => {
    const last = loadReplay(repoRoot, runId).steps.length - 1;
    const prefix = prefixAt(last);
    assertValid(prefix);
    // read + patch produced two assistant tool turns, each answered.
    const toolMsgs = prefix.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(prefix.some((m) => m.role === 'assistant' && m.toolCalls?.[0]?.name === 'read_file')).toBe(true);
    expect(prefix.some((m) => m.role === 'assistant' && m.toolCalls?.[0]?.name === 'apply_patch')).toBe(true);
  });

  it('TRUNCATES a dangling tool call when the fork cuts a turn before its result', () => {
    // Index of the apply_patch announcement (turn 2), BEFORE its patch_applied.
    const model = loadReplay(repoRoot, runId);
    const announceIndex = model.steps.findIndex(
      (s) => s.event.type === 'tool_call' && s.event.payload['tool'] === 'apply_patch',
    );
    const prefix = prefixAt(announceIndex);
    assertValid(prefix); // must STILL be valid — the dangling patch call is dropped
    // The read tool call (turn 1) survives; the apply_patch one is trimmed.
    const names = prefix
      .filter((m) => m.role === 'assistant' && m.toolCalls)
      .flatMap((m) => m.toolCalls?.map((c) => c.name) ?? []);
    expect(names).toContain('read_file');
    expect(names).not.toContain('apply_patch');
  });

  it('planFork reports the cached cost/tokens and the worktree base diff', () => {
    const model = loadReplay(repoRoot, runId);
    const plan = planFork(repoRoot, runId, model.steps.length - 1);
    expect(plan.source.runId).toBe(runId);
    expect(plan.cachedTokens.input).toBe(2000); // 800 + 900 + 300
    expect(plan.cachedCostCents).toBe(8); // 3 + 4 + 1
    expect(plan.baseDiff).toContain('if (!cart) return 0;');
    expect(plan.prefixEvents.length).toBeGreaterThan(0);
  });

  it('restampEventsForFork re-stamps the run id and marks events cached', () => {
    const plan = planFork(repoRoot, runId, 2);
    const restamped = restampEventsForFork(plan.prefixEvents, 'run_fork');
    expect(restamped.every((e) => e.runId === 'run_fork')).toBe(true);
    expect(restamped.every((e) => e.payload['cached'] === true)).toBe(true);
    expect(restamped.every((e) => e.payload['replayedFromRunId'] === runId)).toBe(true);
  });

  it('restampEventsForFork gives fresh, non-colliding ids and keeps the original id', () => {
    const plan = planFork(repoRoot, runId, 2);
    const originalIds = plan.prefixEvents.map((e) => e.id);
    const restamped = restampEventsForFork(plan.prefixEvents, 'run_fork');
    // No restamped id collides with a source-run id (both logs are ingestable together).
    const originalSet = new Set(originalIds);
    expect(restamped.every((e) => !originalSet.has(e.id))).toBe(true);
    // Ids are unique within the forked prefix.
    expect(new Set(restamped.map((e) => e.id)).size).toBe(restamped.length);
    // Provenance is preserved for the time-machine / Workbench.
    restamped.forEach((e, i) => {
      expect(e.payload['replayedFromEventId']).toBe(originalIds[i]);
      expect(e.id).toBe(`run_fork:fork:${i}`);
    });
  });

  it('planUndo returns the target + full accumulated diffs', () => {
    const plan = planUndo(repoRoot, runId, 0);
    expect(plan.runId).toBe(runId);
    expect(plan.fullDiff).toContain('if (!cart) return 0;');
    // At step 0 (run_started) nothing has changed yet → empty target.
    expect(plan.targetDiff).toBe('');
  });
});
