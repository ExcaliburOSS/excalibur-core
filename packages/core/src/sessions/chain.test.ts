import { describe, expect, it } from 'vitest';
import {
  buildChainPrompt,
  parseChainRequest,
  parseChain,
  buildSupervisorPrompt,
  parseSupervisorDecision,
  superviseCompletion,
  type ChainContext,
} from './chain';

describe('buildChainPrompt', () => {
  it('embeds the request and asks for the {task, followUp} JSON in-language', () => {
    const p = buildChainPrompt('build X and then run the tests');
    expect(p).toContain('build X and then run the tests');
    expect(p).toContain('"followUp"');
    expect(p).toContain('SAME LANGUAGE');
  });
});

describe('parseChainRequest', () => {
  it('extracts a primary task + follow-up', () => {
    const out = parseChainRequest(
      JSON.stringify({ task: 'build the API', followUp: 'run the tests' }),
      'fallback',
    );
    expect(out).toEqual({ task: 'build the API', followUp: 'run the tests' });
  });

  it('treats a null/absent/empty followUp as no chain', () => {
    expect(
      parseChainRequest(JSON.stringify({ task: 'x', followUp: null }), 'f').followUp,
    ).toBeNull();
    expect(parseChainRequest(JSON.stringify({ task: 'x' }), 'f').followUp).toBeNull();
    expect(
      parseChainRequest(JSON.stringify({ task: 'x', followUp: '  ' }), 'f').followUp,
    ).toBeNull();
  });

  it('drops a follow-up identical to the task (not a real chain)', () => {
    expect(
      parseChainRequest(JSON.stringify({ task: 'do x', followUp: 'do x' }), 'f').followUp,
    ).toBeNull();
  });

  it('falls back to the original request on junk / missing task', () => {
    expect(parseChainRequest('not json', 'the whole thing')).toEqual({
      task: 'the whole thing',
      followUp: null,
    });
    expect(parseChainRequest(JSON.stringify({ followUp: 'y' }), 'orig').task).toBe('orig');
  });
});

describe('parseChain (gating of the model call)', () => {
  const ctx = (over: Partial<ChainContext> = {}): ChainContext => ({
    interactive: true,
    mock: false,
    ...over,
  });

  it('returns the whole request with no follow-up (no model call) when mock/non-interactive/blank', async () => {
    let calls = 0;
    const model = async (): Promise<string> => {
      calls += 1;
      return '{"task":"a","followUp":"b"}';
    };
    expect(await parseChain('a then b', ctx({ mock: true }), model)).toEqual({
      task: 'a then b',
      followUp: null,
    });
    expect(await parseChain('a then b', ctx({ interactive: false }), model)).toEqual({
      task: 'a then b',
      followUp: null,
    });
    expect(await parseChain('   ', ctx(), model)).toEqual({ task: '', followUp: null });
    expect(calls).toBe(0);
  });

  it('calls the model on a real turn and parses the chain', async () => {
    const model = async (): Promise<string> =>
      '{"task":"build the referral program","followUp":"write the docs"}';
    expect(
      await parseChain('build the referral program then write the docs', ctx(), model),
    ).toEqual({ task: 'build the referral program', followUp: 'write the docs' });
  });

  it('never throws — a model fault yields the request with no follow-up', async () => {
    const model = async (): Promise<string> => {
      throw new Error('overloaded');
    };
    expect(await parseChain('do the thing', ctx(), model)).toEqual({
      task: 'do the thing',
      followUp: null,
    });
  });
});

describe('parseSupervisorDecision (AO8-2)', () => {
  it('parses continue / escalate / done', () => {
    expect(
      parseSupervisorDecision(
        JSON.stringify({ action: 'continue', followUp: 'add tests', note: 'good idea' }),
      ),
    ).toEqual({ action: 'continue', followUp: 'add tests', note: 'good idea' });
    expect(
      parseSupervisorDecision(JSON.stringify({ action: 'escalate', note: 'needs you' })),
    ).toEqual({
      action: 'escalate',
      followUp: null,
      note: 'needs you',
    });
    expect(parseSupervisorDecision(JSON.stringify({ action: 'done' }))).toEqual({
      action: 'done',
      followUp: null,
      note: null,
    });
  });

  it('downgrades a `continue` with no follow-up to `done` (not actionable)', () => {
    expect(
      parseSupervisorDecision(JSON.stringify({ action: 'continue', followUp: null })).action,
    ).toBe('done');
  });

  it('defaults to `done` on junk / unknown action', () => {
    expect(parseSupervisorDecision('not json')).toEqual({
      action: 'done',
      followUp: null,
      note: null,
    });
    expect(parseSupervisorDecision(JSON.stringify({ action: 'explode' })).action).toBe('done');
  });
});

describe('superviseCompletion (gating)', () => {
  const ctx = (over: Partial<ChainContext> = {}): ChainContext => ({
    interactive: true,
    mock: false,
    ...over,
  });
  it('returns `done` without a model call when mock / non-interactive', async () => {
    let calls = 0;
    const model = async (): Promise<string> => {
      calls += 1;
      return '{"action":"continue","followUp":"x"}';
    };
    expect(
      await superviseCompletion({ task: 't', outcome: 'done' }, ctx({ mock: true }), model),
    ).toEqual({
      action: 'done',
      followUp: null,
      note: null,
    });
    expect(calls).toBe(0);
  });
  it('embeds the outcome in the prompt and parses the model decision', async () => {
    const p = buildSupervisorPrompt({ task: 'build X', outcome: 'failed', error: 'tests red' });
    expect(p).toContain('build X');
    expect(p).toContain('failed');
    expect(p).toContain('tests red');
    const model = async (): Promise<string> => '{"action":"escalate","note":"the suite is broken"}';
    const d = await superviseCompletion({ task: 'build X', outcome: 'failed' }, ctx(), model);
    expect(d).toEqual({ action: 'escalate', followUp: null, note: 'the suite is broken' });
  });
});
