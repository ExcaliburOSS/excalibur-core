import { describe, expect, it } from 'vitest';
import { diffPlans, renderPlanDiff } from './plan-diff';
import type { StructuredPlan } from './plan-model';

/** Builds a plan from a {phase: [stepTitles]} spec (ids are positional). */
function plan(spec: Record<string, string[]>): StructuredPlan {
  let p = 0;
  return {
    version: 1,
    phases: Object.entries(spec).map(([title, steps]) => {
      p += 1;
      return {
        id: `p${p}`,
        title,
        steps: steps.map((t, i) => ({
          id: `p${p}.s${i + 1}`,
          title: t,
          status: 'pending' as const,
        })),
      };
    }),
  };
}

describe('diffPlans', () => {
  it('reports identical when nothing changed', () => {
    const a = plan({ Setup: ['Install', 'Configure'] });
    const d = diffPlans(a, plan({ Setup: ['Install', 'Configure'] }));
    expect(d.identical).toBe(true);
    expect(d.summary).toMatchObject({ added: 0, removed: 0, renamed: 0, moved: 0, unchanged: 2 });
    expect(renderPlanDiff(d)).toEqual(['No changes — the plan is identical.']);
  });

  it('detects an ADDED step without shifting everything after it (id-independent)', () => {
    // A step inserted in the middle: positional ids all shift, but title-matching
    // must see exactly one 'added', the rest unchanged.
    const before = plan({ Build: ['Compile', 'Link', 'Package'] });
    const after = plan({ Build: ['Compile', 'Optimize', 'Link', 'Package'] });
    const d = diffPlans(before, after);
    expect(d.summary).toMatchObject({ added: 1, removed: 0, renamed: 0, unchanged: 3 });
    expect(d.steps.find((s) => s.title === 'Optimize')?.change).toBe('added');
    expect(d.steps.find((s) => s.title === 'Link')?.change).toBe('unchanged');
  });

  it('detects a REMOVED step', () => {
    const d = diffPlans(
      plan({ Tests: ['Unit', 'E2E', 'Load'] }),
      plan({ Tests: ['Unit', 'Load'] }),
    );
    expect(d.summary).toMatchObject({ removed: 1, unchanged: 2 });
    const removed = d.steps.find((s) => s.change === 'removed');
    expect(removed?.title).toBe('E2E');
    expect(removed?.phase).toBe('Tests');
  });

  it('detects a RENAMED step via fuzzy title match', () => {
    const d = diffPlans(
      plan({ Setup: ['Add the config schema'] }),
      plan({ Setup: ['Add the config schema and defaults'] }),
    );
    expect(d.summary.renamed).toBe(1);
    const renamed = d.steps.find((s) => s.change === 'renamed');
    expect(renamed?.oldTitle).toBe('Add the config schema');
    expect(renamed?.title).toBe('Add the config schema and defaults');
  });

  it('detects a MOVED step (same title, different phase) + a renamed phase', () => {
    const before = plan({ 'Phase A': ['Wire it up'], 'Phase B': ['Test it'] });
    const after = plan({ 'Phase A (revised)': [], Build: ['Wire it up'], 'Phase B': ['Test it'] });
    const d = diffPlans(before, after);
    const moved = d.steps.find((s) => s.title === 'Wire it up');
    expect(moved?.change).toBe('moved');
    expect(moved?.oldPhase).toBe('Phase A');
    expect(moved?.phase).toBe('Build');
    // "Phase A" → "Phase A (revised)" is a fuzzy phase rename; "Build" is added.
    expect(d.phases.find((p) => p.title === 'Build')?.change).toBe('added');
  });

  it('renders a readable +/−/~ summary grouped by phase', () => {
    const before = plan({ Setup: ['Install', 'Configure'] });
    const after = plan({ Setup: ['Install', 'Configure CI', 'Lint'] });
    const lines = renderPlanDiff(diffPlans(before, after));
    expect(lines[0]).toContain('+1 added');
    expect(lines[0]).toContain('~1 renamed');
    expect(lines.join('\n')).toContain('Configure → Configure CI');
    expect(lines.join('\n')).toContain('+ Lint');
  });
});
