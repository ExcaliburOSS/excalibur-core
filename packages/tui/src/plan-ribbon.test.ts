import { describe, expect, it } from 'vitest';
import { renderPlanRibbon, type PlanRibbonModel } from './plan-ribbon.js';

const model = (over: Partial<PlanRibbonModel> = {}): PlanRibbonModel => ({
  task: 'Add OAuth2 login (Google + GitHub)',
  done: 2,
  total: 4,
  outcome: 'executing',
  phases: [
    {
      id: 'p1',
      title: 'Setup',
      steps: [
        { id: 'p1.s1', title: 'Map the auth module', status: 'done' },
        { id: 'p1.s2', title: 'Add the provider config', status: 'done' },
      ],
    },
    {
      id: 'p2',
      title: 'Build',
      steps: [
        { id: 'p2.s1', title: 'Implement the Google flow', status: 'active' },
        { id: 'p2.s2', title: 'Implement the GitHub flow', status: 'pending' },
      ],
    },
  ],
  ...over,
});

describe('renderPlanRibbon (PLAN4 live plan tree, pure)', () => {
  it('renders a header + phase titles + one line per step', () => {
    const lines = renderPlanRibbon(model());
    expect(lines[0]).toContain('Plan:');
    expect(lines[0]).toContain('Add OAuth2 login');
    expect(lines[0]).toContain('2/4'); // done/total roll-up
    // header + 2 phase titles + 4 steps.
    expect(lines).toHaveLength(7);
    const body = lines.slice(1).join('\n');
    expect(body).toMatch(/Setup[\s\S]*Map the auth[\s\S]*Build[\s\S]*Implement the Google/);
  });

  it('uses status glyphs (done ✓ · active spinner · pending ○ · blocked ✗ · skipped ⊘)', () => {
    const lines = renderPlanRibbon(
      model({
        phases: [
          {
            id: 'p1',
            title: '',
            steps: [
              { id: 'a', title: 'done step', status: 'done' },
              { id: 'b', title: 'active step', status: 'active' },
              { id: 'c', title: 'pending step', status: 'pending' },
              { id: 'd', title: 'blocked step', status: 'blocked' },
              { id: 'e', title: 'skipped step', status: 'skipped' },
            ],
          },
        ],
      }),
      { spinnerFrame: 0 },
    );
    expect(lines.find((l) => l.includes('done step'))).toContain('✓');
    expect(lines.find((l) => l.includes('active step'))).toMatch(/[◐⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(lines.find((l) => l.includes('pending step'))).toContain('○');
    expect(lines.find((l) => l.includes('blocked step'))).toContain('✗');
    expect(lines.find((l) => l.includes('skipped step'))).toContain('⊘');
  });

  it('uses tree connectors within a phase — middle (├) for all but the last (└)', () => {
    const lines = renderPlanRibbon(
      model({
        phases: [
          {
            id: 'p1',
            title: 'Only phase',
            steps: [
              { id: 'a', title: 'first', status: 'done' },
              { id: 'b', title: 'second', status: 'active' },
              { id: 'c', title: 'third', status: 'pending' },
            ],
          },
        ],
      }),
    );
    const stepLines = lines.filter((l) => /first|second|third/.test(l));
    expect(stepLines.slice(0, -1).every((l) => l.includes('├'))).toBe(true);
    expect(stepLines.at(-1)).toContain('└');
  });

  it('colours the header by outcome (paused/blocked/completed) — opt-in via tier', () => {
    // With no tier the output is plain (snapshot-stable); the glyph is still ◆.
    expect(renderPlanRibbon(model({ outcome: 'completed' }))[0]).toContain('◆');
    // With a tier the header carries an SGR colour sequence.
    const painted = renderPlanRibbon(model({ outcome: 'blocked' }), { tier: 'truecolor' });
    // eslint-disable-next-line no-control-regex
    expect(painted[0]).toMatch(/\[/);
  });

  it('omits the done/total annotation when total is 0', () => {
    const lines = renderPlanRibbon(model({ total: 0, done: 0 }));
    expect(lines[0]).not.toMatch(/\d+\/\d+/);
  });
});
