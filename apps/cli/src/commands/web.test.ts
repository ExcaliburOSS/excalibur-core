import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

describe('excalibur web reader (F5 config)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = makeTempRepo();
    await createTestCli({ cwd: repo }).run('init', '--yes');
  });
  afterEach(() => removeDir(repo));

  it('reports no hosted reader by default', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('web', 'reader');
    expect(cli.stdout()).toMatch(/No hosted reader/i);
  });

  it('sets a hosted reader and persists scrape.provider', async () => {
    await createTestCli({ cwd: repo }).run('web', 'reader', 'jina');
    const config = parseYaml(readFileSync(join(repo, '.excalibur', 'config.yaml'), 'utf8')) as {
      scrape?: { provider?: string };
    };
    expect(config.scrape?.provider).toBe('jina');
  });

  it('rejects an unknown hosted reader', async () => {
    await expect(createTestCli({ cwd: repo }).run('web', 'reader', 'nope-reader')).rejects.toThrow(
      /Unknown hosted reader/,
    );
  });
});
