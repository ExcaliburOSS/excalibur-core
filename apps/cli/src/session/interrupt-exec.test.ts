import { describe, expect, it } from 'vitest';
import type { InterruptOutcome } from '@excalibur/core';
import { executeInterrupt, type InterruptOps } from './interrupt-exec';

/** A recording fake of the session lifecycle ops. */
function fakeOps(): InterruptOps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    say: (t) => calls.push(`say:${t}`),
    abort: () => calls.push('abort'),
    runParallel: (t) => calls.push(`parallel:${t}`),
    queueForeground: (t, o) =>
      calls.push(`queue:${t}:abort=${o.abortCurrent}:reask=${o.reaskAfter ?? ''}`),
    recordMessage: (t) => calls.push(`record:${t}`),
  };
}

/** Builds an outcome with a given action/ack/reask (the triage detail is irrelevant here). */
function outcome(
  action: InterruptOutcome['plan']['action'],
  reaskAfter = false,
  ack = 'ack',
): InterruptOutcome {
  return {
    decision: { cls: 'new', confidence: 'high' },
    independence: null,
    plan: { action, reaskAfter, ack },
  };
}

describe('executeInterrupt', () => {
  it('always shows the ack first', () => {
    const ops = fakeOps();
    executeInterrupt(outcome('fold', false, 'Folding…'), 'x', ops);
    expect(ops.calls[0]).toBe('say:Folding…');
  });

  it('stop → abort', () => {
    const ops = fakeOps();
    executeInterrupt(outcome('abort'), 'stop', ops);
    expect(ops.calls).toEqual(['say:ack', 'abort']);
  });

  it('parallel → runs the original text as a background thread', () => {
    const ops = fakeOps();
    executeInterrupt(outcome('parallel'), 'update the docs', ops);
    expect(ops.calls).toContain('parallel:update the docs');
  });

  it('pause_switch → aborts the current turn and queues the new work', () => {
    const ops = fakeOps();
    executeInterrupt(outcome('pause_switch'), 'fix the other bug', ops);
    expect(ops.calls).toEqual(['say:ack', 'queue:fix the other bug:abort=true:reask=']);
  });

  it('fold → queues a follow-up WITHOUT aborting the current work', () => {
    const ops = fakeOps();
    executeInterrupt(outcome('fold'), 'also add a test', ops);
    expect(ops.calls).toEqual(['say:ack', 'queue:also add a test:abort=false:reask=']);
  });

  it('feed_answer → records the message (the run consumes it)', () => {
    const ops = fakeOps();
    executeInterrupt(outcome('feed_answer'), 'yes, overwrite', ops);
    expect(ops.calls).toEqual(['say:ack', 'record:yes, overwrite']);
  });

  it('answer_inline (quick aside) → records it; the run keeps going', () => {
    const ops = fakeOps();
    executeInterrupt(outcome('answer_inline'), 'how long left?', ops);
    expect(ops.calls).toEqual(['say:ack', 'record:how long left?']);
  });

  it('re-asks a pending question after a side-question while awaiting an answer', () => {
    const ops = fakeOps();
    // A quick aside while the run was blocked on "Approve writing limiter.ts?".
    executeInterrupt(
      outcome('answer_inline', true),
      'wait, what file?',
      ops,
      'Approve writing limiter.ts?',
    );
    expect(ops.calls).toEqual([
      'say:ack',
      'record:wait, what file?',
      'queue:Approve writing limiter.ts?:abort=false:reask=',
    ]);
  });

  it('pause_switch carries the re-ask into the queued switch', () => {
    const ops = fakeOps();
    executeInterrupt(outcome('pause_switch', true), 'do the other thing', ops, 'Approve?');
    expect(ops.calls).toEqual(['say:ack', 'queue:do the other thing:abort=true:reask=Approve?']);
  });
});
