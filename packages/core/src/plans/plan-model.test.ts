import { describe, expect, it } from 'vitest';
import {
  findStep,
  isStructuredPlan,
  nextPendingStep,
  parsePlanMarkdown,
  planProgress,
  renderPlanMarkdown,
  type StructuredPlan,
} from './plan-model';

describe('parsePlanMarkdown', () => {
  it('parses a bare numbered list into a single "Plan" phase with steps', () => {
    const plan = parsePlanMarkdown('1. Read models\n2. Extract guard\n3. Add tests');
    expect(plan.version).toBe(1);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0]?.title).toBe('Plan');
    expect(plan.phases[0]?.steps.map((s) => s.title)).toEqual([
      'Read models',
      'Extract guard',
      'Add tests',
    ]);
    expect(plan.phases[0]?.steps.map((s) => s.id)).toEqual(['p1.s1', 'p1.s2', 'p1.s3']);
    expect(plan.phases[0]?.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('parses headings into phases (stripping a "Phase N:" label) with their steps', () => {
    const md = [
      '## Phase 1: Foundation',
      '1. Read the schema',
      '2. Define types',
      '',
      '## Implement',
      '- Write the store',
      '- Add tests',
    ].join('\n');
    const plan = parsePlanMarkdown(md);
    expect(plan.phases.map((p) => p.title)).toEqual(['Foundation', 'Implement']);
    expect(plan.phases[0]?.id).toBe('p1');
    expect(plan.phases[1]?.id).toBe('p2');
    expect(plan.phases[1]?.steps.map((s) => s.id)).toEqual(['p2.s1', 'p2.s2']);
  });

  it('reads a [x]-style status box on a step', () => {
    const plan = parsePlanMarkdown(
      '- [x] done one\n- [~] active one\n- [!] blocked one\n- [ ] todo',
    );
    expect(plan.phases[0]?.steps.map((s) => s.status)).toEqual([
      'done',
      'active',
      'blocked',
      'pending',
    ]);
  });

  it('drops empty heading-only phases but keeps one "Plan" phase when there is text', () => {
    expect(parsePlanMarkdown('## A\n## B\nsome prose, no list items').phases).toEqual([
      { id: 'p1', title: 'Plan', steps: [] },
    ]);
    expect(parsePlanMarkdown('').phases).toEqual([]);
  });

  it('ignores prose lines between steps (they stay in the .md body)', () => {
    const plan = parsePlanMarkdown('Intro paragraph.\n\n1. First\nMore prose.\n2. Second');
    expect(plan.phases[0]?.steps.map((s) => s.title)).toEqual(['First', 'Second']);
  });
});

describe('renderPlanMarkdown', () => {
  it('renders a single "Plan" phase as a bare checkbox list (no heading)', () => {
    const plan: StructuredPlan = {
      version: 1,
      phases: [
        {
          id: 'p1',
          title: 'Plan',
          steps: [
            { id: 'p1.s1', title: 'Do A', status: 'done' },
            { id: 'p1.s2', title: 'Do B', status: 'pending', acceptance: 'B passes' },
          ],
        },
      ],
    };
    const md = renderPlanMarkdown(plan);
    expect(md).toContain('- [x] Do A');
    expect(md).toContain('- [ ] Do B');
    expect(md).toContain('_acceptance:_ B passes');
    expect(md).not.toContain('## Plan');
  });

  it('round-trips structure + status through render → parse for a multi-phase plan', () => {
    const plan: StructuredPlan = {
      version: 1,
      phases: [
        {
          id: 'p1',
          title: 'Foundation',
          steps: [
            { id: 'p1.s1', title: 'Schema', status: 'done' },
            { id: 'p1.s2', title: 'Types', status: 'active' },
          ],
        },
        { id: 'p2', title: 'Ship', steps: [{ id: 'p2.s1', title: 'Release', status: 'blocked' }] },
      ],
    };
    const reparsed = parsePlanMarkdown(renderPlanMarkdown(plan));
    expect(reparsed.phases.map((p) => p.title)).toEqual(['Foundation', 'Ship']);
    expect(reparsed.phases.flatMap((p) => p.steps.map((s) => s.status))).toEqual([
      'done',
      'active',
      'blocked',
    ]);
  });

  it('renders an empty plan with a placeholder', () => {
    expect(renderPlanMarkdown({ version: 1, phases: [] })).toBe('_No steps yet._');
  });
});

describe('plan helpers', () => {
  const plan: StructuredPlan = {
    version: 1,
    phases: [
      {
        id: 'p1',
        title: 'A',
        steps: [
          { id: 'p1.s1', title: 'one', status: 'done' },
          { id: 'p1.s2', title: 'two', status: 'active' },
        ],
      },
      { id: 'p2', title: 'B', steps: [{ id: 'p2.s1', title: 'three', status: 'pending' }] },
    ],
  };

  it('planProgress counts by status', () => {
    expect(planProgress(plan)).toEqual({ total: 3, done: 1, active: 1, blocked: 0 });
  });

  it('nextPendingStep returns the first not-done/not-skipped step', () => {
    expect(nextPendingStep(plan)?.step.id).toBe('p1.s2'); // the active one
    const allDone: StructuredPlan = {
      version: 1,
      phases: [{ id: 'p1', title: 'A', steps: [{ id: 'p1.s1', title: 'x', status: 'done' }] }],
    };
    expect(nextPendingStep(allDone)).toBeNull();
  });

  it('findStep locates a step + its phase by id', () => {
    expect(findStep(plan, 'p2.s1')?.phase.id).toBe('p2');
    expect(findStep(plan, 'nope')).toBeNull();
  });

  it('isStructuredPlan validates the shape (defensive for on-disk JSON)', () => {
    expect(isStructuredPlan(plan)).toBe(true);
    expect(isStructuredPlan({ version: 2, phases: [] })).toBe(false);
    expect(isStructuredPlan({ phases: 'nope' })).toBe(false);
    expect(isStructuredPlan(null)).toBe(false);
  });
});
