import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryShapePrompt,
  discoveryShape,
  parseDiscoveryShape,
  type DiscoveryShapeContext,
} from './discovery-shaping';

describe('buildDiscoveryShapePrompt', () => {
  it('embeds the input, type and baseline pack, and asks for same-language JSON', () => {
    const p = buildDiscoveryShapePrompt('A mobile onboarding revamp', 'idea', [
      'Who is the user?',
      'What is the goal?',
    ]);
    expect(p).toContain('A mobile onboarding revamp');
    expect(p).toContain('"idea"');
    expect(p).toContain('Who is the user?');
    expect(p).toContain('SAME LANGUAGE');
    expect(p).toContain('"recommendations"');
  });

  it('handles an empty baseline pack', () => {
    expect(buildDiscoveryShapePrompt('x', 'work_item', [])).toContain('(none)');
  });
});

describe('parseDiscoveryShape', () => {
  it('parses + clamps to ≤5 questions / ≤6 recs and sanitizes strings', () => {
    const out = parseDiscoveryShape(
      JSON.stringify({
        questions: ['a', 'b', 'c', 'd', 'e', 'f'],
        recommendations: [
          { title: 'Success\nmetrics', detail: 'how we measure', recommended: true },
          { title: '', detail: 'no title — dropped' },
        ],
      }),
    );
    expect(out.questions).toHaveLength(5);
    expect(out.recommendations).toHaveLength(1);
    expect(out.recommendations[0]?.title).toBe('Success metrics'); // newline collapsed
    expect(out.recommendations[0]?.recommended).toBe(true);
  });

  it('returns empty on junk', () => {
    expect(parseDiscoveryShape('not json')).toEqual({ questions: [], recommendations: [] });
  });
});

describe('discoveryShape (technical gate only — no complexity grade)', () => {
  const ctx = (over: Partial<DiscoveryShapeContext> = {}): DiscoveryShapeContext => ({
    interactive: true,
    mock: false,
    ...over,
  });

  it('returns empty WITHOUT calling the model for mock / non-interactive / blank input', async () => {
    let calls = 0;
    const model = async (): Promise<string> => {
      calls += 1;
      return '{"questions":["q"],"recommendations":[]}';
    };
    expect(await discoveryShape('idea', 'idea', [], ctx({ mock: true }), model)).toEqual({
      questions: [],
      recommendations: [],
    });
    expect(await discoveryShape('idea', 'idea', [], ctx({ interactive: false }), model)).toEqual({
      questions: [],
      recommendations: [],
    });
    expect(await discoveryShape('   ', 'idea', [], ctx(), model)).toEqual({
      questions: [],
      recommendations: [],
    });
    expect(calls).toBe(0);
  });

  it('calls the model on a real interactive turn and parses its answer', async () => {
    const model = async (): Promise<string> =>
      '{"questions":["Who are the target users?"],"recommendations":[{"title":"Define success metrics","detail":"x","recommended":true}]}';
    const out = await discoveryShape(
      'Build a referral program',
      'idea',
      ['generic?'],
      ctx(),
      model,
    );
    expect(out.questions).toEqual(['Who are the target users?']);
    expect(out.recommendations[0]?.recommended).toBe(true);
  });

  it('never throws — a model fault yields the empty shape (caller falls back to static pack)', async () => {
    const model = async (): Promise<string> => {
      throw new Error('overloaded');
    };
    expect(await discoveryShape('idea', 'idea', [], ctx(), model)).toEqual({
      questions: [],
      recommendations: [],
    });
  });
});
