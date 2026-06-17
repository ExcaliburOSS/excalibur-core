import { excaliburEventSchema, type ExcaliburEvent } from '@excalibur/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir, setFastVerifyCommands } from '../test-utils';
import { parseOutputFormat } from '../lib/run-output';

const repo = makeTempRepo();

beforeAll(async () => {
  await createTestCli({ cwd: repo }).run('init', '--yes');
  setFastVerifyCommands(repo); // real, instant verify commands (no node/pnpm startup)
});

afterAll(() => removeDir(repo));

describe('run --output-format (headless / scripting, Build Contract §4.9)', () => {
  it('rejects an unknown format with a usage error', () => {
    expect(() => parseOutputFormat('yaml')).toThrow(/--output-format must be one of/);
  });

  it('accepts the three known formats and defaults to undefined when absent', () => {
    expect(parseOutputFormat(undefined)).toBeUndefined();
    expect(parseOutputFormat('text')).toBe('text');
    expect(parseOutputFormat('json')).toBe('json');
    expect(parseOutputFormat('stream-json')).toBe('stream-json');
  });

  it('text (default) is unchanged: human output, no JSON document', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('run', 'Fix typo in README.md', '--yes');
    const stdout = cli.stdout();
    expect(stdout).toContain('Fast Fix');
    expect(stdout).toContain('fast-fix');
    expect(stdout).toContain('run completed');
    // No top-level JSON object/array document.
    expect(stdout.trimStart().startsWith('{')).toBe(false);
    expect(stdout.trimStart().startsWith('[')).toBe(false);
  });

  it('--output-format json prints one JSON document of { run, events } and no human chatter', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('run', 'Fix another typo in README.md', '--yes', '--output-format', 'json');

    const stdout = cli.stdout().trim();
    // The human header/summary must be suppressed in machine mode: no plan-card
    // border, no success line. ("Fast Fix" itself is legitimate JSON data — it's
    // the workflow name in a `workflow_selected` event — so we key on chrome-only
    // markers instead.)
    expect(stdout).not.toContain('┌─');
    expect(stdout).not.toContain('run completed');

    const parsed = JSON.parse(stdout) as {
      run: { id: string; status: string; workflow: string };
      events: ExcaliburEvent[];
    };
    expect(parsed.run.status).toBe('completed');
    expect(parsed.run.workflow).toBe('fast-fix');
    expect(parsed.run.id).toMatch(/^run_/);

    // Every emitted event matches the shared event contract.
    for (const event of parsed.events) {
      expect(() => excaliburEventSchema.parse(event)).not.toThrow();
    }
    const types = parsed.events.map((event) => event.type);
    expect(types[0]).toBe('run_started');
    expect(types[types.length - 1]).toBe('run_completed');
    expect(types).toContain('workflow_selected');
  });

  it('--output-format stream-json prints one parseable JSON event per line (NDJSON)', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run(
      'run',
      'Fix a third typo in README.md',
      '--yes',
      '--output-format',
      'stream-json',
    );

    const lines = cli
      .stdout()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(lines.length).toBeGreaterThan(1);
    // Each line is a self-contained event matching the contract.
    const events = lines.map((line) => excaliburEventSchema.parse(JSON.parse(line)));
    expect(events[0]?.type).toBe('run_started');
    expect(events[events.length - 1]?.type).toBe('run_completed');
    // Pretty-printed JSON would split objects across lines; assert single-line.
    for (const line of lines) {
      expect(line.startsWith('{')).toBe(true);
      expect(line.endsWith('}')).toBe(true);
    }
  });
});
