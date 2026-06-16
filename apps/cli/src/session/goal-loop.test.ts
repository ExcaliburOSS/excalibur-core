import { PassThrough, Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import { DEFAULT_CONFIG } from '@excalibur/shared';
import type { ChatInput, ChatOutput, ModelGateway } from '@excalibur/model-gateway';
import { Ui } from '../ui';
import { defaultDeps, type CliDeps } from '../deps';
import { makeTempRepo, removeDir } from '../test-utils';
import type { AgentTurnDeps } from './agent-turn';
import { parseVerdict, runGoalLoop, type GoalVerdict } from './goal-loop';

const repo = makeTempRepo();
afterAll(() => removeDir(repo));

class MemoryStream extends Writable {
  override _write(_c: unknown, _e: string, cb: () => void): void {
    cb();
  }
}

function makeDeps(): CliDeps {
  const ui = new Ui({
    stdout: new MemoryStream(),
    stderr: new MemoryStream(),
    stdin: new PassThrough(),
    interactive: false,
  });
  return defaultDeps({
    ui,
    cwd: () => repo,
    homeDir: () => repo,
    env: { PATH: process.env.PATH },
    includeUserGlobal: false,
  });
}

/** A gateway whose agent turn always returns the same final text (no tools). */
function fakeGateway(answer: string): ModelGateway {
  return {
    chat: (_input: ChatInput): Promise<ChatOutput> =>
      Promise.resolve({
        content: answer,
        model: 'fake',
        usage: { inputTokens: 5, outputTokens: 5 },
        costCents: 1,
        finishReason: 'stop',
      }),
  } as unknown as ModelGateway;
}

function turn(gw: ModelGateway): AgentTurnDeps {
  return {
    deps: makeDeps(),
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    gateway: gw,
    providerName: 'fake',
    autonomyLevel: 1,
    adapter: new NativeAgentAdapter(),
  };
}

describe('parseVerdict', () => {
  it('parses clean JSON', () => {
    expect(parseVerdict('{"done": true, "reason": "all good"}')).toEqual({
      done: true,
      reason: 'all good',
    });
  });
  it('extracts JSON embedded in prose', () => {
    expect(parseVerdict('Here is my verdict: {"done": false, "reason": "tests fail"}.').done).toBe(
      false,
    );
  });
  it('is conservative (done=false) on unparseable output', () => {
    expect(parseVerdict('I think it is probably fine').done).toBe(false);
  });
});

describe('runGoalLoop', () => {
  it('iterates until the evaluator says done', async () => {
    const verdicts: GoalVerdict[] = [
      { done: false, reason: '1' },
      { done: false, reason: '2' },
      { done: true, reason: 'complete' },
    ];
    let i = 0;
    const result = await runGoalLoop(turn(fakeGateway('working on it')), 'do the thing', {
      maxIterations: 6,
      evaluate: () => Promise.resolve(verdicts[i++]!),
    });
    expect(result.status).toBe('done');
    expect(result.iterations).toBe(3);
    expect(result.results).toHaveLength(3);
    expect(result.lastReason).toBe('complete');
  });

  it('stops at the iteration cap when never done', async () => {
    const result = await runGoalLoop(turn(fakeGateway('still going')), 'g', {
      maxIterations: 3,
      evaluate: () => Promise.resolve({ done: false, reason: 'not yet' }),
    });
    expect(result.status).toBe('max-iterations');
    expect(result.iterations).toBe(3);
  });

  it('reports evaluator-failed (no runaway) when the judge throws', async () => {
    const result = await runGoalLoop(turn(fakeGateway('x')), 'g', {
      maxIterations: 5,
      evaluate: () => Promise.reject(new Error('judge unreachable')),
    });
    expect(result.status).toBe('evaluator-failed');
    expect(result.iterations).toBe(1);
  });

  it('aborts before running when the signal is already aborted', async () => {
    const result = await runGoalLoop(turn(fakeGateway('x')), 'g', {
      maxIterations: 3,
      signal: AbortSignal.abort(),
      evaluate: () => Promise.resolve({ done: false, reason: 'x' }),
    });
    expect(result.status).toBe('aborted');
    expect(result.iterations).toBe(0);
  });
});
