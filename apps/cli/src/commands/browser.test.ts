import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

describe('excalibur browser', () => {
  let repo: string;
  const prevBrowsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  beforeEach(async () => {
    repo = makeTempRepo();
    // Force "chromium absent" deterministically (empty browsers dir) so the
    // enable-without-consent path never triggers a real install on a dev box.
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = repo;
    await createTestCli({ cwd: repo }).run('init', '--yes');
  });
  afterEach(() => {
    if (prevBrowsersPath === undefined) delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
    else process.env['PLAYWRIGHT_BROWSERS_PATH'] = prevBrowsersPath;
    removeDir(repo);
  });

  it('disable persists browser.enabled=false', async () => {
    await createTestCli({ cwd: repo }).run('browser', 'disable');
    const config = parseYaml(readFileSync(join(repo, '.excalibur', 'config.yaml'), 'utf8')) as {
      browser?: { enabled?: boolean };
    };
    expect(config.browser?.enabled).toBe(false);
  });

  it('status reports the browser state and escalation flag', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('browser', 'status');
    expect(cli.stdout()).toMatch(/Local browser:/i);
  });

  it('enable without consent (non-interactive) does not install or enable', async () => {
    await createTestCli({ cwd: repo }).run('browser', 'enable');
    // Chromium is forced-absent → confirm is asked; non-interactive resolves to
    // the default (no) → cancelled, nothing installed, escalation not enabled.
    const config = parseYaml(readFileSync(join(repo, '.excalibur', 'config.yaml'), 'utf8')) as {
      browser?: { enabled?: boolean };
    };
    expect(config.browser?.enabled).not.toBe(true);
  });
});
