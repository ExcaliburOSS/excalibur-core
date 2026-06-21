import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) removeDir(dir);
});

describe('excalibur new', () => {
  it('creates a fresh subdirectory with a minimal .excalibur/ scaffold', async () => {
    const parent = makeTempRepo({ mockProvider: false });
    cleanups.push(parent);
    const cli = createTestCli({ cwd: parent });
    await cli.run('new', 'demo-app');

    const root = join(parent, 'demo-app');
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, '.excalibur', 'config.yaml'))).toBe(true);

    const stdout = cli.stdout();
    expect(stdout).toContain('demo-app');
    expect(stdout.toLowerCase()).toContain('cd demo-app');
  });

  it('refuses a name that already exists', async () => {
    const parent = makeTempRepo({ mockProvider: false });
    cleanups.push(parent);
    const cli = createTestCli({ cwd: parent });
    await cli.run('new', 'taken');
    // Second time the directory exists → a CliUsageError (parseAsync rejects).
    await expect(cli.run('new', 'taken')).rejects.toThrow();
  });
});
