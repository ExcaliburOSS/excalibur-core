import { describe, expect, it } from 'vitest';
import { renderRibbon, type MissionRibbonModel } from './mission-ribbon.js';

const model = (over: Partial<MissionRibbonModel> = {}): MissionRibbonModel => ({
  goal: 'Add OAuth2 login (Google + GitHub)',
  steps: [
    { id: 'u', capability: 'understand', objective: 'map auth', status: 'done', gate: false },
    { id: 'p', capability: 'plan', objective: 'design flows', status: 'done', gate: false },
    {
      id: 'i',
      capability: 'parallelize',
      objective: 'impl providers',
      status: 'running',
      gate: false,
    },
    { id: 't', capability: 'test', objective: 'run suite', status: 'pending', gate: true },
    { id: 'v', capability: 'verify', objective: 'audit', status: 'pending', gate: true },
  ],
  ...over,
});

describe('renderRibbon (M7 plan ribbon, pure)', () => {
  it('renders a header + one line per capability step', () => {
    const lines = renderRibbon(model());
    expect(lines[0]).toContain('Mission:');
    expect(lines[0]).toContain('Add OAuth2 login');
    expect(lines).toHaveLength(6); // header + 5 steps
    // Capability names appear in order.
    const body = lines.slice(1).join('\n');
    expect(body).toMatch(/understand[\s\S]*plan[\s\S]*parallelize[\s\S]*test[\s\S]*verify/);
  });

  it('uses status glyphs (done ✓ · running ◐ · pending ○) and marks gates', () => {
    const lines = renderRibbon(model(), { spinnerFrame: 0 });
    const understand = lines.find((l) => l.includes('understand'));
    const running = lines.find((l) => l.includes('parallelize'));
    const test = lines.find((l) => l.includes('test'));
    expect(understand).toContain('✓'); // done
    expect(running).toMatch(/[◐⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/); // running spinner/◐
    expect(test).toContain('○'); // pending
    expect(test).toContain('(gate)'); // a gate step is marked
  });

  it('shows skipped (⊘) and a retry (↻) marker', () => {
    const lines = renderRibbon(
      model({
        steps: [
          { id: 'a', capability: 'implement', objective: 'x', status: 'skipped', gate: false },
          {
            id: 'b',
            capability: 'test',
            objective: 'y',
            status: 'failed',
            gate: false,
            attempts: 2,
          },
        ],
      }),
    );
    expect(lines.find((l) => l.includes('implement'))).toContain('⊘');
    const failed = lines.find((l) => l.includes('test'));
    expect(failed).toContain('✗');
    expect(failed).toContain('↻'); // attempts > 1
  });

  it('shows budget/criteria/elapsed in the header when present', () => {
    const lines = renderRibbon(
      model({
        spentCents: 42,
        budgetCents: 500,
        criteriaMet: 2,
        criteriaTotal: 4,
        elapsedMs: 65_000,
      }),
    );
    expect(lines[0]).toContain('$0.42/$5.00');
    expect(lines[0]).toContain('2/4');
    expect(lines[0]).toContain('1m'); // 65s → 1m05s-ish
  });

  it('uses tree connectors — middle (├) for all but the last (└)', () => {
    const lines = renderRibbon(model());
    const stepLines = lines.slice(1);
    expect(stepLines.slice(0, -1).every((l) => l.includes('├'))).toBe(true);
    expect(stepLines.at(-1)).toContain('└');
  });
});
