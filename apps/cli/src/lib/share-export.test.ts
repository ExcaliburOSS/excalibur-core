import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@excalibur/shared';
import type { RailModel } from '@excalibur/tui';
import { buildRunShareHtml } from './share-export';

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_20260623_101500',
    title: 'Add a feature',
    autonomyLevel: 3,
    workflow: 'fast-fix',
    methodology: null,
    status: 'completed',
    model: 'kimi',
    executionStyle: 'fast',
    startedAt: '2026-06-23T10:15:00.000Z',
    completedAt: '2026-06-23T10:20:00.000Z',
    ...overrides,
  } as RunRecord;
}

function rail(overrides: Partial<RailModel> = {}): RailModel {
  return {
    runId: 'run_20260623_101500',
    title: 'Add a feature',
    autonomyLabel: 'L3',
    phases: [],
    status: { elapsedMs: 1000, costCents: 12, model: 'kimi', inputTokens: 100, outputTokens: 50 },
    done: true,
    errored: false,
    ...overrides,
  } as RailModel;
}

describe('buildRunShareHtml', () => {
  it('embeds the run data and is openable standalone', () => {
    const html = buildRunShareHtml(record(), rail());
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('run_20260623_101500'); // id embedded
    expect(html).toContain('Add a feature'); // title in the JSON
    expect(html).toContain('Content-Security-Policy'); // defense in depth
    expect(html).toContain('application/json'); // data carried as JSON, not HTML
  });

  it('neutralizes a script-injection attempt in the run title (no </script> breakout)', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const html = buildRunShareHtml(record({ title: evil }), rail({ title: evil }));
    // The raw closing tag from the title must NOT appear — `<` is escaped to <
    // inside the embedded JSON, so it can't terminate the data <script> element.
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>\\u003cimg'); // escaped form present
  });
});
