import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ExcaliburConfig } from '@excalibur/shared';
import { fakeAnalysis } from '../test-utils';
import { buildStatusLineModel, routeInput, type RouteContext } from './intent-router';

const ctx: RouteContext = {
  analysis: fakeAnalysis(),
  config: DEFAULT_CONFIG,
};

describe('routeInput — structural recognition', () => {
  it('routes a leading / to a slash command with argv', () => {
    const decision = routeInput('/resume sess_20260101_000000', ctx);
    expect(decision).toEqual({ kind: 'command', name: 'resume', argv: ['sess_20260101_000000'] });
  });

  it('lowercases the command name and respects quotes in argv', () => {
    const decision = routeInput('/Model "gpt 4o"', ctx);
    expect(decision).toEqual({ kind: 'command', name: 'model', argv: ['gpt 4o'] });
  });

  it('routes a leading ! to a shell passthrough', () => {
    const decision = routeInput('!ls -la', ctx);
    expect(decision).toEqual({ kind: 'shell', command: 'ls -la' });
  });
});

describe('routeInput — natural-language lanes (table-driven)', () => {
  const cases: Array<{ name: string; input: string; lane: string }> = [
    { name: 'ambiguous short input → discovery', input: 'thing', lane: 'discovery' },
    {
      name: 'no clear verb → discovery',
      input: 'the whole onboarding experience',
      lane: 'discovery',
    },
    {
      name: 'question ending in ? → ask',
      input: 'How does the run pipeline select a workflow?',
      lane: 'ask',
    },
    {
      name: 'interrogative lead → ask',
      input: 'what files implement the session store',
      lane: 'ask',
    },
    {
      name: 'actionable verb → run',
      input: 'Add a retry with backoff to the fetch transport',
      lane: 'run',
    },
    {
      name: 'refactor → run',
      input: 'Refactor the run command to extract a pipeline helper',
      lane: 'run',
    },
    {
      name: 'sensitive auth task → careful',
      input: 'Fix the broken login session expiry in the auth module',
      lane: 'careful',
    },
    {
      name: 'migration → careful',
      input: 'Add a database migration to add a tier column',
      lane: 'careful',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const decision = routeInput(testCase.input, ctx);
      expect(decision.kind).toBe('natural');
      if (decision.kind === 'natural') {
        expect(decision.lane).toBe(testCase.lane);
        expect(decision.reason.length).toBeGreaterThan(0);
        expect(typeof decision.intent).toBe('string');
      }
    });
  }

  it('an actionable verb that opens with an interrogative-ish word still runs', () => {
    // "Make ..." is actionable; never an ask.
    const decision = routeInput('Make the welcome banner theme-friendly', ctx);
    expect(decision.kind).toBe('natural');
    if (decision.kind === 'natural') {
      expect(decision.lane).toBe('run');
    }
  });

  it('never calls a model (purely deterministic — stable across calls)', () => {
    const a = routeInput('Add pagination to the logs command', ctx);
    const b = routeInput('Add pagination to the logs command', ctx);
    expect(a).toEqual(b);
  });
});

describe('buildStatusLineModel', () => {
  it('derives autonomy / model / safety / cost from the config', () => {
    const model = buildStatusLineModel({
      config: DEFAULT_CONFIG,
      model: 'mock',
      costCents: 12,
      autonomyLevel: 3,
      workflow: 'fast-fix',
    });
    expect(model).toEqual({
      autonomy: 'L3 Branch',
      workflow: 'fast-fix',
      model: 'mock',
      costCents: 12,
      safety: 'standard-safe',
    });
  });

  it('falls back to the default safety preset when the config names an unknown one', () => {
    const config: ExcaliburConfig = { ...DEFAULT_CONFIG, safety: { preset: 'does-not-exist' } };
    const model = buildStatusLineModel({ config, model: 'mock' });
    expect(model.safety).toBe('standard-safe');
    // Defaults: cost 0, workflow placeholder.
    expect(model.costCents).toBe(0);
    expect(model.workflow).toBe('conversation');
  });

  it('uses the config autonomy default when no level is supplied', () => {
    const config: ExcaliburConfig = { ...DEFAULT_CONFIG, autonomy: { default: 1 } };
    const model = buildStatusLineModel({ config, model: 'mock' });
    expect(model.autonomy).toBe('L1 Assist');
  });
});
