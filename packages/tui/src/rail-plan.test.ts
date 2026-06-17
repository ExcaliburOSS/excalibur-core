import { describe, expect, it } from 'vitest';
import { stripAnsi } from './color.js';
import { renderPlanCard, type PlanCardModel } from './rail-plan.js';

const model = (over: Partial<PlanCardModel> = {}): PlanCardModel => ({
  workflowName: 'Fast Fix',
  workflowId: 'fast-fix',
  autonomyLabel: 'L3 — Implement in Branch',
  phases: [
    { name: 'Analyze', type: 'assistant_interaction' },
    { name: 'Patch', type: 'patch_generation' },
    { name: 'Optional Apply', type: 'apply_patch', optional: true },
    { name: 'Summarize', type: 'agent_output' },
  ],
  gate: '[Enter] run · [m] mode · [c] cancel',
  ...over,
});

describe('renderPlanCard', () => {
  it('renders a bordered, gated node with a phase node per phase', () => {
    const text = renderPlanCard(model()).join('\n');
    // Bordered: top-left + bottom-left corners present.
    expect(text).toContain('┌');
    expect(text).toContain('└');
    // Header + autonomy.
    expect(text).toContain('Fast Fix');
    expect(text).toContain('L3 — Implement in Branch · fast-fix');
    // A pending node per phase, with type + optional marker.
    expect(text).toContain('○ Analyze');
    expect(text).toContain('assistant_interaction');
    expect(text).toContain('Optional Apply');
    expect(text).toContain('(optional)');
    // Gate line.
    expect(text).toContain('[Enter] run · [m] mode · [c] cancel');
  });

  it('shows the swarm + sensitive lines only when present', () => {
    const plain = renderPlanCard(model()).join('\n');
    expect(plain).not.toContain('swarm ·');
    expect(plain).not.toContain('sensitive ·');

    const rich = renderPlanCard(
      model({ swarmReason: 'Sized to 3 agents', sensitiveAreas: ['auth', 'billing'] }),
    ).join('\n');
    expect(rich).toContain('swarm · Sized to 3 agents');
    expect(rich).toContain('sensitive · auth, billing');
  });

  it('coloured output strips back to the plain form byte-identically', () => {
    const m = model({ swarmReason: 'Sized to 2 agents' });
    const plain = renderPlanCard(m);
    const coloured = renderPlanCard(m, { tier: 'truecolor', mode: 'light' });
    expect(coloured.join('\n')).toContain('\x1b[38;2;');
    expect(coloured.map(stripAnsi)).toEqual(plain);
  });
});
