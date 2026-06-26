import { describe, expect, it, vi } from 'vitest';
import {
  assessIndependence,
  buildIndependencePrompt,
  buildInterruptPrompt,
  classifyInterrupt,
  parseIndependence,
  parseInterruptClass,
  parseInterruptConfidence,
  parseInterruptDecision,
  planInterrupt,
  decideInterrupt,
  type IndependenceContext,
  type InterruptClass,
  type InterruptContext,
} from './interrupt-router';

const busy: InterruptContext = {
  currentWork: 'refactoring the rate limiter',
  awaitingAnswer: false,
};
const asking: InterruptContext = {
  currentWork: 'refactoring the rate limiter',
  awaitingAnswer: true,
  pendingQuestion: 'Approve writing src/api/limiter.ts?',
};

describe('parseInterruptClass', () => {
  it('maps the model answer to a class', () => {
    expect(parseInterruptClass('steer high', busy)).toBe('steer');
    expect(parseInterruptClass('  NEW \n', busy)).toBe('new');
    expect(parseInterruptClass('category: stop', busy)).toBe('stop');
    expect(parseInterruptClass('quick medium', busy)).toBe('quick');
  });

  it('defaults unknown → new when busy, answer when awaiting', () => {
    expect(parseInterruptClass('je ne sais pas', busy)).toBe('new');
    expect(parseInterruptClass('', busy)).toBe('new');
    expect(parseInterruptClass('no idea', asking)).toBe('answer');
  });

  it('downgrades "answer" to "new" when Excalibur is NOT awaiting an answer', () => {
    expect(parseInterruptClass('answer high', busy)).toBe('new');
    expect(parseInterruptClass('answer high', asking)).toBe('answer');
  });
});

describe('parseInterruptConfidence / parseInterruptDecision', () => {
  it('extracts confidence; unknown → medium', () => {
    expect(parseInterruptConfidence('steer high')).toBe('high');
    expect(parseInterruptConfidence('new low')).toBe('low');
    expect(parseInterruptConfidence('stop')).toBe('medium');
  });
  it('parses class + confidence together', () => {
    expect(parseInterruptDecision('steer high', busy)).toEqual({
      cls: 'steer',
      confidence: 'high',
    });
    expect(parseInterruptDecision('nonsense', busy)).toEqual({ cls: 'new', confidence: 'medium' });
  });
});

describe('buildInterruptPrompt', () => {
  it('carries the current work + the user input, and the pending question only when awaiting', () => {
    const busyP = buildInterruptPrompt('also handle the error case', busy);
    expect(busyP).toContain('refactoring the rate limiter');
    expect(busyP).toContain('also handle the error case');
    expect(busyP).not.toContain('Approve writing'); // not awaiting → no pending question
    expect(busyP).toContain('never choose it'); // answer is disabled

    const askP = buildInterruptPrompt('what does this file do?', asking);
    expect(askP).toContain('Approve writing src/api/limiter.ts?');
    expect(askP).toContain('this IS the answer'); // answer enabled
  });
});

describe('classifyInterrupt (injected model)', () => {
  it('classifies via the model regardless of language', async () => {
    const model = vi.fn().mockResolvedValue('new high');
    expect(await classifyInterrupt('ahora añade modo oscuro', busy, model)).toEqual({
      cls: 'new',
      confidence: 'high',
    });
    expect(model.mock.calls[0]?.[0]).toContain('ahora añade modo oscuro');
  });

  it('falls back safely on empty input or a model error (no throw)', async () => {
    const model = vi.fn().mockResolvedValue('steer high');
    expect(await classifyInterrupt('   ', busy, model)).toEqual({ cls: 'new', confidence: 'low' });
    expect(model).not.toHaveBeenCalled();
    const boom = vi.fn().mockRejectedValue(new Error('down'));
    expect(await classifyInterrupt('do X', asking, boom)).toEqual({
      cls: 'answer',
      confidence: 'low',
    });
  });
});

const indepCtx: IndependenceContext = {
  currentWork: 'refactoring the rate limiter',
  touchedPaths: ['src/api/limiter.ts', 'src/api/refill.ts'],
};

describe('parseIndependence', () => {
  it('reads INDEPENDENT vs OVERLAP, defaulting to NOT independent', () => {
    expect(
      parseIndependence('INDEPENDENT — the navbar is unrelated to the limiter').independent,
    ).toBe(true);
    expect(parseIndependence('OVERLAP — both edit src/api/limiter.ts').independent).toBe(false);
    // "not independent" must NOT read as independent despite the substring.
    expect(parseIndependence('Not independent: same module').independent).toBe(false);
    // Unknown → conservative (pause).
    expect(parseIndependence('hmm, unsure').independent).toBe(false);
  });
});

describe('assessIndependence (injected model)', () => {
  it('carries the touched paths + the new request into the prompt', () => {
    const p = buildIndependencePrompt('add a dark-mode toggle to the navbar', indepCtx);
    expect(p).toContain('src/api/limiter.ts');
    expect(p).toContain('dark-mode toggle');
  });

  it('judges via the model; conservative (pause) on error or empty', async () => {
    const indep = vi.fn().mockResolvedValue('INDEPENDENT — the navbar does not touch the limiter');
    expect((await assessIndependence('add a navbar toggle', indepCtx, indep)).independent).toBe(
      true,
    );
    const overlap = vi.fn().mockResolvedValue('OVERLAP — both change the refill window');
    expect((await assessIndependence('fix the refill window', indepCtx, overlap)).independent).toBe(
      false,
    );
    const boom = vi.fn().mockRejectedValue(new Error('down'));
    expect((await assessIndependence('do X', indepCtx, boom)).independent).toBe(false);
    expect((await assessIndependence('   ', indepCtx, indep)).independent).toBe(false);
  });
});

describe('planInterrupt (routing + ack, INT-4)', () => {
  const dec = (cls: InterruptClass, confidence: 'high' | 'medium' | 'low' = 'high') => ({
    cls,
    confidence,
  });

  it('steer → fold; quick → answer_inline; stop → abort', () => {
    expect(planInterrupt(dec('steer'), null, busy).action).toBe('fold');
    expect(planInterrupt(dec('quick'), null, busy).action).toBe('answer_inline');
    expect(planInterrupt(dec('stop'), null, busy).action).toBe('abort');
  });

  it('new → parallel when independent, pause_switch when not', () => {
    expect(planInterrupt(dec('new'), { independent: true, reason: '' }, busy).action).toBe(
      'parallel',
    );
    expect(planInterrupt(dec('new'), { independent: false, reason: '' }, busy).action).toBe(
      'pause_switch',
    );
    expect(planInterrupt(dec('new'), null, busy).action).toBe('pause_switch'); // no verdict → pause
  });

  it('while awaiting: answer feeds it (no re-ask); a side question re-asks after', () => {
    const ans = planInterrupt(dec('answer'), null, asking);
    expect(ans.action).toBe('feed_answer');
    expect(ans.reaskAfter).toBe(false);
    const side = planInterrupt(dec('quick'), null, asking);
    expect(side.action).toBe('answer_inline');
    expect(side.reaskAfter).toBe(true); // re-ask the pending approval after
    // stop while awaiting cancels, does NOT re-ask.
    expect(planInterrupt(dec('stop'), null, asking).reaskAfter).toBe(false);
  });

  it('the ack names the action + invites correction on a non-high-confidence read', () => {
    expect(planInterrupt(dec('steer', 'high'), null, busy).ack.length).toBeGreaterThan(0);
    const lowNew = planInterrupt(dec('new', 'low'), { independent: true, reason: '' }, busy);
    expect(lowNew.ack).toContain('parallel');
    expect(lowNew.ack.toLowerCase()).toContain('separate'); // correction hint
    const highNew = planInterrupt(dec('new', 'high'), { independent: true, reason: '' }, busy);
    expect(highNew.ack.toLowerCase()).not.toContain('say "no'); // no hint at high confidence
  });
});

describe('decideInterrupt (full triage → route, INT-1 wiring)', () => {
  it('steer: classifies and folds WITHOUT an independence call', async () => {
    const model = vi.fn().mockResolvedValue('steer high');
    const out = await decideInterrupt('also handle the null case', busy, model);
    expect(out.decision.cls).toBe('steer');
    expect(out.independence).toBeNull(); // independence is only judged for NEW work
    expect(out.plan.action).toBe('fold');
    expect(model).toHaveBeenCalledTimes(1); // classify only — no second (independence) call
  });

  it('new + independent → parallel (two model calls: classify then independence)', async () => {
    const model = vi
      .fn()
      .mockResolvedValueOnce('new high')
      .mockResolvedValueOnce('INDEPENDENT — the docs site does not touch the limiter');
    const out = await decideInterrupt('update the README badges', busy, model);
    expect(out.decision.cls).toBe('new');
    expect(out.independence?.independent).toBe(true);
    expect(out.plan.action).toBe('parallel');
    expect(model).toHaveBeenCalledTimes(2);
  });

  it('new + overlapping → pause_switch', async () => {
    const model = vi
      .fn()
      .mockResolvedValueOnce('new medium')
      .mockResolvedValueOnce('OVERLAP — both edit the rate limiter');
    const out = await decideInterrupt('rewrite the refill window', busy, model);
    expect(out.plan.action).toBe('pause_switch');
  });

  it('while awaiting: the answer feeds it (no independence call, no re-ask)', async () => {
    const model = vi.fn().mockResolvedValue('answer high');
    const out = await decideInterrupt('yes, overwrite it', asking, model);
    expect(out.plan.action).toBe('feed_answer');
    expect(out.plan.reaskAfter).toBe(false);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('degrades safely when the model throws — treat as new, pause (never lose the run)', async () => {
    const model = vi.fn().mockRejectedValue(new Error('down'));
    const out = await decideInterrupt('do something', busy, model);
    expect(out.decision.cls).toBe('new'); // classify fell back to new
    expect(out.plan.action).toBe('pause_switch'); // independence also failed → conservative pause
  });
});
