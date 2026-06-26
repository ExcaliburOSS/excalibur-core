import { describe, expect, it, vi } from 'vitest';
import {
  buildInterruptPrompt,
  classifyInterrupt,
  parseInterruptClass,
  parseInterruptConfidence,
  parseInterruptDecision,
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
