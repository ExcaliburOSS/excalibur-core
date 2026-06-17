import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseEventsJsonl, runRecordSchema } from '@excalibur/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

const repo = makeTempRepo();

beforeAll(async () => {
  // Detected commands (pnpm test / pnpm run lint) feed the verify phase.
  await createTestCli({ cwd: repo }).run('init', '--yes');
});

afterAll(() => removeDir(repo));

function runDirs(): string[] {
  const base = join(repo, '.excalibur', 'runs');
  return existsSync(base) ? readdirSync(base).sort() : [];
}

describe('run (local mock loop, Build Contract §4.9)', () => {
  it('executes a fast-fix run end to end with --yes', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('run', 'Fix typo in README.md', '--yes');

    const stdout = cli.stdout();
    // The plan card (bordered, gated node) shows the workflow + id, plus the
    // visible safety preset (onboarding §5/§6).
    expect(stdout).toContain('Fast Fix');
    expect(stdout).toContain('fast-fix');
    expect(stdout).toContain('Safety: standard-safe');
    expect(stdout).toContain('run completed');

    const dirs = runDirs();
    expect(dirs.length).toBe(1);
    const runDir = join(repo, '.excalibur', 'runs', dirs[0] as string);

    const record = runRecordSchema.parse(JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')));
    expect(record.status).toBe('completed');
    expect(record.workflow).toBe('fast-fix');
    expect(record.autonomyLevel).toBe(3);

    const events = parseEventsJsonl(readFileSync(join(runDir, 'events.jsonl'), 'utf8'));
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run_started');
    expect(types).toContain('workflow_selected');
    expect(types).toContain('patch_generated');
    expect(types[types.length - 1]).toBe('run_completed');

    // Simulated commands only — M1 never executes anything real.
    const command = events.find((event) => event.type === 'command_started');
    expect(command?.payload['simulated']).toBe(true);

    for (const artifact of ['workflow.yaml', 'input.md', 'diff.patch', 'summary.md']) {
      expect(existsSync(join(runDir, artifact)), `${artifact} must exist`).toBe(true);
    }
  });

  it('selects explore-alternatives with --explore', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('run', 'Implement contract versioning approaches', '--explore', '--yes');
    expect(cli.stdout()).toContain('explore-alternatives');
  });

  it('records a methodology via defaultWorkflow reverse-lookup for a standard-feature run', async () => {
    // standard-feature shares no id with any methodology; the run must still
    // attach a methodology (spec-driven/plan-then-execute → structured/standard)
    // resolved by `defaultWorkflow`, and emit `methodology_selected` + write
    // `methodology.yaml` (regression for the namespace-conflation finding).
    const cli = createTestCli({ cwd: repo });
    await cli.run('run', 'Add a new pricing tier feature with full tests', '--structured', '--yes');

    const dirs = runDirs();
    const latest = join(repo, '.excalibur', 'runs', dirs[dirs.length - 1] as string);
    const record = runRecordSchema.parse(JSON.parse(readFileSync(join(latest, 'run.json'), 'utf8')));

    expect(record.workflow).toBe('structured-feature');
    // spec-driven declares defaultWorkflow: structured-feature.
    expect(record.methodology).toBe('spec-driven');

    const events = parseEventsJsonl(readFileSync(join(latest, 'events.jsonl'), 'utf8'));
    expect(events.some((event) => event.type === 'methodology_selected')).toBe(true);
    expect(existsSync(join(latest, 'methodology.yaml'))).toBe(true);
  });

  it('rejects an invalid --level (usage error)', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('run', 'Fix bug', '--level', '9')).rejects.toThrow(/--level must be 0\.\.4/);
  });

  it('rejects conflicting style flags', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('run', 'Fix bug', '--fast', '--careful')).rejects.toThrow(/at most one/);
  });

  it('rejects an unknown explicit workflow', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('run', 'Fix bug now please', '--workflow', 'does-not-exist', '--yes')).rejects.toThrow(
      /Unknown workflow/,
    );
  });
});

describe('status / logs', () => {
  it('status lists runs with workflow and level', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('status');
    expect(cli.stdout()).toContain('fast-fix');
    expect(cli.stdout()).toContain('L3');
  });

  it('status --json is machine readable', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('status', '--json');
    const parsed = JSON.parse(cli.stdout()) as { runs: unknown[] };
    expect(parsed.runs.length).toBeGreaterThan(0);
  });

  it('logs prettifies the latest run events', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('logs');
    expect(cli.stdout()).toContain('run_started');
    expect(cli.stdout()).toContain('run_completed');
  });

  it('logs --json returns the raw events', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('logs', '--json');
    const events = JSON.parse(cli.stdout()) as Array<{ type: string }>;
    expect(events.some((event) => event.type === 'run_started')).toBe(true);
  });

  it('logs of an unknown run id fails with run_not_found', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('logs', 'run_19990101_000000')).rejects.toThrow(/not found/i);
  });
});

describe('pr-summary', () => {
  it('prints the pr-summary of the latest run, generating it when missing', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('pr-summary');
    expect(cli.stdout().length).toBeGreaterThan(0);
    const dirs = runDirs();
    const latest = join(repo, '.excalibur', 'runs', dirs[dirs.length - 1] as string);
    expect(existsSync(join(latest, 'pr-summary.md'))).toBe(true);
  });
});
