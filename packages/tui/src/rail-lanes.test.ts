import { describe, expect, it } from 'vitest';
import { stripAnsi } from './color.js';
import { renderLanes, type LanesModel } from './rail-lanes.js';

const model = (): LanesModel => ({
  lanes: [
    {
      id: 'l1',
      title: 'add retry logic',
      state: 'done',
      toolCalls: 3,
      diff: { additions: 24, deletions: 6, files: 2 },
      costCents: 3,
    },
    { id: 'l2', title: 'update tests', state: 'empty', toolCalls: 1, costCents: 2 },
    { id: 'l3', title: 'docs', state: 'failed', detail: 'failed: timeout' },
    { id: 'l4', title: 'rename API', state: 'conflict', detail: 'merge conflict' },
  ],
  applied: 1,
  conflicts: 1,
});

describe('renderLanes', () => {
  it('renders a swarm header, one sub-rail per lane, and a merge footer', () => {
    const text = renderLanes(model()).join('\n');
    expect(text).toContain('Swarm · 4 lanes');
    // A lane line per lane, with title + stats.
    expect(text).toContain('add retry logic');
    expect(text).toContain('+24 −6 · 2 files');
    expect(text).toContain('3t'); // tool calls
    expect(text).toContain('$0.03');
    // Failure / conflict details surface.
    expect(text).toContain('failed: timeout');
    expect(text).toContain('merge conflict');
    // Tree connectors: middle lanes branch, the last closes.
    expect(text).toContain('├');
    expect(text).toContain('└');
    // Merge footer with applied + conflict counts.
    expect(text).toContain('merge · 1 applied · 1 conflict');
  });

  it('omits the conflict clause when there are none', () => {
    const text = renderLanes({
      lanes: [{ id: 'l1', title: 'x', state: 'done' }],
      applied: 1,
      conflicts: 0,
    }).join('\n');
    expect(text).toContain('merge · 1 applied');
    expect(text).not.toContain('conflict');
  });

  it('coloured output strips back to the plain form byte-identically', () => {
    const m = model();
    const plain = renderLanes(m);
    const coloured = renderLanes(m, { tier: 'truecolor', mode: 'dark' });
    expect(coloured.join('\n')).toContain('\x1b[38;2;');
    expect(coloured.map(stripAnsi)).toEqual(plain);
  });

  it("paints a 'running' (in-flight) lane in the accent colour (live animation)", () => {
    const running = { id: 'r1', title: 'refactor auth', state: 'running' as const };
    const plain = renderLanes({ lanes: [running], applied: 0, conflicts: 0 });
    expect(plain.join('\n')).toContain('refactor auth'); // renders fine in plain form
    const coloured = renderLanes({ lanes: [running], applied: 0, conflicts: 0 }, {
      tier: 'truecolor',
      mode: 'dark',
    }).join('\n');
    // accent #5BC8FF → 91;200;255 marks the in-flight lane (distinct from done/green).
    expect(coloured).toContain('\x1b[38;2;91;200;255m');
  });
});
