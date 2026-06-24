import { describe, expect, it } from 'vitest';
import {
  buildPlanShapePrompt,
  parsePlanShape,
  planShape,
  shouldAskPlanQuestions,
  shouldSurfacePlanShape,
  type PlanRecommendation,
  type PlanShape,
} from './plan-shaping';
import type { IntentContext } from './intent-router';

const rec = (title: string, recommended = false): PlanRecommendation => ({
  title,
  detail: '',
  recommended,
});
const shape = (over: Partial<PlanShape> = {}): PlanShape => ({
  complexity: 'medium',
  clear: true,
  questions: [],
  recommendations: [],
  ...over,
});

describe('shouldSurfacePlanShape (the gate — keeps shaping OFF for medium/clear tasks)', () => {
  it('stays silent when there is nothing concrete to show', () => {
    expect(shouldSurfacePlanShape(shape({ complexity: 'large', clear: false }))).toBe(false);
  });

  it('NEVER surfaces for a small task, even with content', () => {
    expect(
      shouldSurfacePlanShape(shape({ complexity: 'small', recommendations: [rec('Add tests')] })),
    ).toBe(false);
    expect(
      shouldSurfacePlanShape(
        shape({ complexity: 'small', clear: false, questions: ['Which db?'] }),
      ),
    ).toBe(false);
  });

  it('stays SILENT for a clear medium task with no optional scope (the core fear)', () => {
    expect(
      shouldSurfacePlanShape(shape({ complexity: 'medium', clear: true, questions: ['x?'] })),
    ).toBe(false);
  });

  it('surfaces a clear medium task ONLY when there is genuine optional scope', () => {
    expect(
      shouldSurfacePlanShape(
        shape({ complexity: 'medium', clear: true, recommendations: [rec('Add migration')] }),
      ),
    ).toBe(true);
  });

  it('surfaces a medium task when the design is NOT clear', () => {
    expect(
      shouldSurfacePlanShape(
        shape({ complexity: 'medium', clear: false, questions: ['Which API?'] }),
      ),
    ).toBe(true);
  });

  it('surfaces a LARGE plan whenever there is something to show', () => {
    expect(
      shouldSurfacePlanShape(shape({ complexity: 'large', clear: true, questions: ['Scope?'] })),
    ).toBe(true);
    expect(
      shouldSurfacePlanShape(shape({ complexity: 'large', recommendations: [rec('Telemetry')] })),
    ).toBe(true);
  });
});

describe('shouldAskPlanQuestions (asymmetric: questions are high-friction → strict)', () => {
  it('asks on a large plan or an unclear design', () => {
    expect(shouldAskPlanQuestions(shape({ complexity: 'large', questions: ['Scope?'] }))).toBe(
      true,
    );
    expect(
      shouldAskPlanQuestions(shape({ complexity: 'medium', clear: false, questions: ['Which?'] })),
    ).toBe(true);
  });

  it('NEVER asks on a clear medium task — even when it surfaced for recommendations', () => {
    const s = shape({
      complexity: 'medium',
      clear: true,
      questions: ['leaked?'],
      recommendations: [rec('Add tests')],
    });
    expect(shouldSurfacePlanShape(s)).toBe(true); // it DID surface (for the recs)…
    expect(shouldAskPlanQuestions(s)).toBe(false); // …but the question is suppressed
  });

  it('does not ask when there are no questions', () => {
    expect(shouldAskPlanQuestions(shape({ complexity: 'large', questions: [] }))).toBe(false);
  });
});

describe('parsePlanShape', () => {
  it('parses a full shape and clamps to ≤3 questions / ≤6 recs', () => {
    const out = parsePlanShape(
      JSON.stringify({
        complexity: 'large',
        clear: false,
        questions: ['a', 'b', 'c', 'd'],
        recommendations: Array.from({ length: 8 }, (_v, i) => ({
          title: `r${i}`,
          detail: 'd',
          recommended: i === 0,
        })),
      }),
    );
    expect(out.complexity).toBe('large');
    expect(out.clear).toBe(false);
    expect(out.questions).toEqual(['a', 'b', 'c']);
    expect(out.recommendations).toHaveLength(6);
    expect(out.recommendations[0]?.recommended).toBe(true);
  });

  it('defaults complexity to "medium" and clear to true when omitted/invalid', () => {
    const out = parsePlanShape(
      JSON.stringify({ complexity: 'huge', questions: [], recommendations: [] }),
    );
    expect(out.complexity).toBe('medium');
    expect(out.clear).toBe(true);
  });

  it('treats clear:false strictly (only the literal false flips it)', () => {
    expect(parsePlanShape(JSON.stringify({ clear: false })).clear).toBe(false);
    expect(parsePlanShape(JSON.stringify({ clear: 'no' })).clear).toBe(true);
    expect(parsePlanShape(JSON.stringify({})).clear).toBe(true);
  });

  it('tolerates prose/fences around the JSON and drops malformed recs', () => {
    const out = parsePlanShape(
      'Here you go:\n```json\n{"complexity":"medium","clear":true,"questions":["q?"],"recommendations":[{"title":"  ok  ","detail":"x"},{"detail":"no title"},42]}\n```',
    );
    expect(out.questions).toEqual(['q?']);
    expect(out.recommendations).toEqual([{ title: 'ok', detail: 'x', recommended: false }]);
  });

  it('sanitizes strings to a single capped line (no newlines/over-long → no TUI corruption)', () => {
    const out = parsePlanShape(
      JSON.stringify({
        complexity: 'large',
        clear: false,
        questions: [`Which\n\ndatabase?  ${'x'.repeat(400)}`],
        recommendations: [{ title: `Add\ntests${'y'.repeat(200)}`, detail: 'a\nb\tc' }],
      }),
    );
    // interior newlines/tabs collapsed to single spaces
    expect(out.questions[0]).not.toContain('\n');
    expect(out.recommendations[0]?.title).not.toContain('\n');
    expect(out.recommendations[0]?.detail).toBe('a b c');
    // length caps (questions ≤200, title ≤80) with an ellipsis
    expect(out.questions[0]!.length).toBeLessThanOrEqual(200);
    expect(out.recommendations[0]!.title.length).toBeLessThanOrEqual(80);
    expect(out.questions[0]).toContain('…');
  });

  it('returns the EMPTY (never-surfacing) shape on junk', () => {
    const out = parsePlanShape('not json at all');
    expect(out).toEqual({ complexity: 'small', clear: true, questions: [], recommendations: [] });
    expect(shouldSurfacePlanShape(out)).toBe(false);
  });
});

describe('buildPlanShapePrompt', () => {
  it('embeds the request and asks for the gated JSON contract', () => {
    const p = buildPlanShapePrompt('Add a dark mode toggle');
    expect(p).toContain('Add a dark mode toggle');
    expect(p).toContain('"complexity"');
    expect(p).toContain('SAME LANGUAGE');
    expect(p).toContain('conservative');
  });
});

describe('planShape (gating of the model call itself)', () => {
  const ctx = (over: Partial<IntentContext> = {}): IntentContext => ({
    interactive: true,
    mock: false,
    level: 4,
    ...over,
  });

  it('returns EMPTY without calling the model for mock / non-interactive / low-autonomy / blank', async () => {
    let calls = 0;
    const model = async (): Promise<string> => {
      calls += 1;
      return '{}';
    };
    expect(await planShape('x', ctx({ mock: true }), model)).toEqual(
      expect.objectContaining({ complexity: 'small' }),
    );
    expect(await planShape('x', ctx({ interactive: false }), model)).toEqual(
      expect.objectContaining({ questions: [] }),
    );
    expect(await planShape('x', ctx({ level: 1 }), model)).toEqual(
      expect.objectContaining({ recommendations: [] }),
    );
    expect(await planShape('   ', ctx(), model)).toEqual(expect.objectContaining({ clear: true }));
    expect(calls).toBe(0);
  });

  it('calls the model on a real interactive turn and parses its answer', async () => {
    const model = async (): Promise<string> =>
      '{"complexity":"large","clear":false,"questions":["Which store?"],"recommendations":[]}';
    const out = await planShape('Build a sync engine', ctx(), model);
    expect(out.complexity).toBe('large');
    expect(out.questions).toEqual(['Which store?']);
  });

  it('never throws — a model fault yields the EMPTY shape', async () => {
    const model = async (): Promise<string> => {
      throw new Error('overloaded');
    };
    expect(await planShape('Build something big', ctx(), model)).toEqual({
      complexity: 'small',
      clear: true,
      questions: [],
      recommendations: [],
    });
  });
});
