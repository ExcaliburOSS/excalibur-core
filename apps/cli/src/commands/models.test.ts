import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir, writeMockProviders } from '../test-utils';

const cleanups: string[] = [];

afterAll(() => {
  for (const dir of cleanups) removeDir(dir);
});

function tempRepo(mockProvider: boolean): string {
  const repo = makeTempRepo({ mockProvider });
  cleanups.push(repo);
  return repo;
}

describe('models test (connection check)', () => {
  it('refuses with setup guidance when no provider is configured (no mock fallback)', async () => {
    const repo = tempRepo(false); // no providers.yaml
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('models', 'test')).rejects.toThrow(/models setup/);
  });

  it('does not hit the network for the offline mock — explains it instead', async () => {
    const repo = tempRepo(false);
    writeMockProviders(repo); // explicit type: mock
    const cli = createTestCli({ cwd: repo });
    await cli.run('models', 'test');
    const stdout = cli.stdout();
    expect(stdout).toContain('offline mock');
    expect(stdout).not.toContain('responded in');
  });
});

describe('models list', () => {
  it('flags the unconfigured repo and points at setup', async () => {
    const repo = tempRepo(false);
    const cli = createTestCli({ cwd: repo });
    await cli.run('models', 'list');
    expect(cli.stdout()).toContain('models setup');
  });

  it('lists both members of a good+fast pair and never treats `cheap` as a provider', async () => {
    const repo = tempRepo(false);
    const dir = join(repo, '.excalibur', 'models');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'providers.yaml'),
      [
        'providers:',
        '  default: main',
        '  cheap: fast',
        '  main:',
        '    type: mock',
        '  fast:',
        '    type: mock',
        '',
      ].join('\n'),
      'utf8',
    );
    const cli = createTestCli({ cwd: repo });
    await cli.run('models', 'list', '--json');
    const rows = JSON.parse(cli.stdout()) as Array<{ name: string; default: boolean }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['fast', 'main']); // the `cheap`/`default` pointers are not rows
    expect(rows.find((r) => r.default)?.name).toBe('main');
  });
});
