import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISCOVERY_ARTIFACT_FILES, discoveryRecordSchema } from '@excalibur/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

const repo = makeTempRepo();

afterAll(() => removeDir(repo));

function sessionDirs(): string[] {
  const base = join(repo, '.excalibur', 'discovery');
  return existsSync(base) ? readdirSync(base).sort() : [];
}

describe('discovery (D-7, discovery-core.md §6)', () => {
  it('runs the full flow with --yes (questions recorded unanswered)', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('discovery', 'Add AI contract renewal reminders', '--yes');

    // Readiness card printed (discovery-core.md §3).
    expect(cli.stdout()).toContain('Problem clarity:');
    expect(cli.stdout()).toContain('Agent readiness:');
    expect(cli.stdout()).toContain('Recommendation:');

    const dirs = sessionDirs();
    expect(dirs.length).toBe(1);
    const dir = join(repo, '.excalibur', 'discovery', dirs[0] as string);
    for (const artifact of DISCOVERY_ARTIFACT_FILES) {
      expect(existsSync(join(dir, artifact)), `${artifact} must exist`).toBe(true);
    }

    const record = discoveryRecordSchema.parse(
      JSON.parse(readFileSync(join(dir, 'discovery.json'), 'utf8')),
    );
    expect(record.status).toBe('completed');
    expect(record.inputType).toBe('idea');
    expect(record.recommendation).not.toBeNull();
  });

  it('creates a native work item from a buildable discovery (W1b)', async () => {
    const r = makeTempRepo();
    try {
      await createTestCli({ cwd: r }).run(
        'discovery',
        'Add CSV export to the reports dashboard',
        '--yes',
      );
      const discBase = join(r, '.excalibur', 'discovery');
      const dirs = existsSync(discBase) ? readdirSync(discBase) : [];
      expect(dirs.length).toBe(1);
      const record = discoveryRecordSchema.parse(
        JSON.parse(readFileSync(join(discBase, dirs[0] as string, 'discovery.json'), 'utf8')),
      );
      const wiBase = join(r, '.excalibur', 'work-items');
      const wis = existsSync(wiBase) ? readdirSync(wiBase).filter((f) => f.endsWith('.json')) : [];
      // A buildable verdict creates a tracked work item; a do_not_build verdict does not.
      if (record.recommendation === 'do_not_build') {
        expect(wis.length).toBe(0);
      } else {
        expect(wis.length).toBeGreaterThan(0);
      }
    } finally {
      removeDir(r);
    }
  });

  it('uses customer_feedback for --from-file inputs', async () => {
    writeFileSync(
      join(repo, 'feedback.md'),
      'Customers keep asking for renewal reminders.\n',
      'utf8',
    );
    const cli = createTestCli({ cwd: repo });
    await cli.run('discovery', '--from-file', 'feedback.md', '--yes');
    const dirs = sessionDirs();
    const dir = join(repo, '.excalibur', 'discovery', dirs[dirs.length - 1] as string);
    const record = discoveryRecordSchema.parse(
      JSON.parse(readFileSync(join(dir, 'discovery.json'), 'utf8')),
    );
    expect(record.inputType).toBe('customer_feedback');
  });

  it('rejects an invalid --type (usage error)', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('discovery', 'Some idea', '--type', 'nonsense', '--yes')).rejects.toThrow(
      /--type must be one of/,
    );
  });

  it('prints an honest M4 notice for work-item sources', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('discovery', '--from-linear', 'ENG-123');
    expect(cli.stdout()).toContain('M4');
  });

  it('requires an input (usage error)', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('discovery', '--yes')).rejects.toThrow(/Provide an idea/);
  });

  it('status --discovery lists local sessions', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('status', '--discovery');
    expect(cli.stdout()).toContain('disc_');
    expect(cli.stdout()).toContain('idea');
  });
});
