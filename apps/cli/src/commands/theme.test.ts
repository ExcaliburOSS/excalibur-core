import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

describe('excalibur theme', () => {
  let repo: string;
  beforeEach(async () => {
    repo = makeTempRepo();
    await createTestCli({ cwd: repo }).run('init', '--yes');
  });
  afterEach(() => removeDir(repo));

  it('lists all themes and marks the current one', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('theme');
    const out = cli.stdout();
    for (const name of ['auto', 'dark', 'light', 'daltonized', 'high-contrast']) {
      expect(out).toContain(name);
    }
    expect(out).toContain('→'); // current marker (auto by default)
  });

  it('sets a theme and persists ui.theme to config.yaml', async () => {
    await createTestCli({ cwd: repo }).run('theme', 'daltonized');
    const config = parseYaml(readFileSync(join(repo, '.excalibur', 'config.yaml'), 'utf8')) as {
      ui?: { theme?: string };
    };
    expect(config.ui?.theme).toBe('daltonized');
  });

  it('rejects an unknown theme name', async () => {
    await expect(createTestCli({ cwd: repo }).run('theme', 'neon-dragon')).rejects.toThrow(
      /Unknown theme/,
    );
  });
});
