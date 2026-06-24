import { describe, expect, it } from 'vitest';
import type { ChronogramDto } from '@excalibur/shared';
import { stripAnsi } from './color.js';
import { renderChronogram } from './chronogram-render.js';

const model = (over: Partial<ChronogramDto> = {}): ChronogramDto => ({
  parentRunId: 'run_parent',
  task: 'ship the thing',
  mode: 'staged',
  status: 'running',
  startedAt: '2026-06-24T00:00:00.000Z',
  completedAt: null,
  workItemId: null,
  waves: [['t1'], ['t2', 't3']],
  lanes: [
    {
      id: 't1',
      title: 'Add retry guard',
      instruction: 'do A',
      wave: 0,
      dependsOn: [],
      state: 'done',
      runId: 'run_a',
      costCents: 12,
      startedAt: '2026-06-24T00:00:00.000Z',
      completedAt: '2026-06-24T00:00:30.000Z',
      durationMs: 30_000,
    },
    {
      id: 't2',
      title: 'Wire it up',
      instruction: 'do B',
      wave: 1,
      dependsOn: ['t1'],
      state: 'running',
      runId: 'run_b',
      costCents: 4,
      startedAt: '2026-06-24T00:00:31.000Z',
      completedAt: null,
      durationMs: null,
    },
    {
      id: 't3',
      title: 'Add a test',
      instruction: 'do C',
      wave: 1,
      dependsOn: ['t1'],
      state: 'pending',
      runId: null,
      costCents: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  ],
  totalCostCents: 16,
  ...over,
});

describe('renderChronogram (AO6 Pillar 2)', () => {
  it('draws a header, one group per wave, lane rows + a fan-in summary', () => {
    const text = renderChronogram(model()).join('\n');
    expect(text).toContain('Chronogram');
    expect(text).toContain('ship the thing');
    // Wave grouping.
    expect(text).toContain('Wave 1');
    expect(text).toContain('Wave 2');
    // Lane titles.
    expect(text).toContain('Add retry guard');
    expect(text).toContain('Wire it up');
    expect(text).toContain('Add a test');
    // Dependency hint resolves the predecessor's title (the DAG edge).
    expect(text).toContain('depends: Add retry guard');
    // Finished lane shows a duration + cost.
    expect(text).toContain('30s');
    expect(text).toContain('$0.12');
    // Fan-in summary tallies states.
    expect(text).toContain('1 done');
    expect(text).toContain('1 running');
    expect(text).toContain('1 pending');
  });

  it('renders proportional duration bars (finished lane fills more than nothing)', () => {
    const text = renderChronogram(model()).join('\n');
    expect(text).toContain('█'); // a filled bar for the finished lane
    expect(text).toContain('░'); // an empty bar for the pending lane
  });

  it('tier none is byte-identical to omitting the option; colour strips back to plain', () => {
    const m = model();
    expect(renderChronogram(m, { tier: 'none' })).toEqual(renderChronogram(m));
    const truecolor = renderChronogram(m, { tier: 'truecolor' });
    expect(truecolor.join('\n')).toContain('\x1b[');
    expect(truecolor.map(stripAnsi)).toEqual(renderChronogram(m));
  });

  it('computes live elapsed for a running lane when nowMs is supplied', () => {
    const text = renderChronogram(model(), {
      nowMs: Date.parse('2026-06-24T00:00:43.000Z'),
    }).join('\n');
    // run_b started at :31, now :43 → 12s elapsed shown on the live lane.
    expect(text).toContain('12s');
  });
});
