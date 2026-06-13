import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCli, makeTempDir, makeTempRepo, removeDir } from '../test-utils';

const repo = makeTempRepo();
const home = makeTempDir('home');

afterAll(() => {
  removeDir(repo);
  removeDir(home);
});

describe('daily / weekly-plan (AA-8)', () => {
  it('daily prints markdown and writes the dated report file', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('daily');
    expect(cli.stdout()).toContain('# Daily Report');
    const reports = readdirSync(join(repo, '.excalibur', 'reports'));
    expect(reports.some((name) => /^daily-\d{4}-\d{2}-\d{2}\.md$/.test(name))).toBe(true);
  });

  it('weekly-plan writes the ISO-week report file', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('weekly-plan');
    expect(cli.stdout()).toContain('# Weekly Plan');
    const reports = readdirSync(join(repo, '.excalibur', 'reports'));
    expect(reports.some((name) => /^weekly-plan-\d{4}-W\d{2}\.md$/.test(name))).toBe(true);
  });
});

describe('login / connect / sync (experimental, OSS spec §13)', () => {
  it('login saves credentials with file mode 0600', async () => {
    const cli = createTestCli({ cwd: repo, homeDir: home });
    await cli.run('login', '--base-url', 'https://ent.example', '--api-key', 'key-123', '--yes');
    const credentialsPath = join(home, '.config', 'excalibur', 'credentials.json');
    expect(existsSync(credentialsPath)).toBe(true);
    const mode = statSync(credentialsPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const stored = JSON.parse(readFileSync(credentialsPath, 'utf8')) as { baseUrl: string };
    expect(stored.baseUrl).toBe('https://ent.example');
    expect(cli.stdout()).toContain('Experimental');
    // The key value is never echoed back.
    expect(cli.stdout()).not.toContain('key-123');
  });

  it('login without a base URL is a usage error', async () => {
    const cli = createTestCli({ cwd: repo, homeDir: makeTempDir('home2') });
    await expect(cli.run('login', '--yes')).rejects.toThrow(/base URL is required/);
  });

  it('login without an api key is a usage error', async () => {
    const cli = createTestCli({ cwd: repo, homeDir: makeTempDir('home3') });
    await expect(
      cli.run('login', '--base-url', 'https://ent.example', '--yes'),
    ).rejects.toThrow(/API key is required/);
  });

  it('connect reports the connection status', async () => {
    const cli = createTestCli({ cwd: repo, homeDir: home });
    await cli.run('connect');
    expect(cli.stdout()).toContain('https://ent.example');
  });

  it('sync without credentials stays local and explains how to connect', async () => {
    const cli = createTestCli({ cwd: repo, homeDir: makeTempDir('home3') });
    await cli.run('sync');
    expect(cli.stdout()).toContain('Not connected');
    expect(cli.stdout()).toContain('Experimental');
  });
});

describe('honest stubs (pr-create, cmux)', () => {
  it('pr-create names its activation milestone and checks for gh', async () => {
    const cli = createTestCli({ cwd: repo, env: { PATH: '' } });
    await cli.run('pr-create');
    expect(cli.stdout()).toContain('OSS-9');
    expect(cli.stdout()).toContain('gh');
  });

  it('cmux names its activation milestone and stays optional', async () => {
    const cli = createTestCli({ cwd: repo, env: { PATH: '' } });
    await cli.run('cmux');
    expect(cli.stdout()).toContain('OSS-10');
    expect(cli.stdout()).toContain('optional');
  });
});

describe('workflows / methodologies catalogs come from the extension host', () => {
  it('workflows list shows all 14 built-ins with source built_in', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('workflows', 'list');
    const stdout = cli.stdout();
    for (const id of [
      'ask-repo',
      'review-only',
      'assist',
      'propose-patch',
      'fast-fix',
      'standard-feature',
      'structured-feature',
      'safe-refactor',
      'pr-review',
      'security-review',
      'migration',
      'explore-alternatives',
      'human-gated',
      'discovery',
    ]) {
      expect(stdout).toContain(id);
    }
    expect(stdout).toContain('built_in');
  });

  it('workflows explain prints phases and artifacts', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('workflows', 'explain', 'fast-fix');
    const stdout = cli.stdout();
    expect(stdout).toContain('Fast Fix');
    expect(stdout).toContain('Phases:');
    expect(stdout).toContain('diff.patch');
  });

  it('workflows explain of an unknown id is a usage error', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('workflows', 'explain', 'nope')).rejects.toThrow(/Unknown workflow/);
  });

  it('a project workflow file overrides the built-in (source: project)', async () => {
    const override = makeTempRepo({ git: false });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const dir = join(override, '.excalibur', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'fast-fix.yaml'),
      [
        'id: fast-fix',
        'name: Team Fast Fix',
        'mode: fast',
        'supportedAutonomyLevels: [2, 3]',
        'phases:',
        '  - id: analyze',
        '    name: Analyze',
        '    type: assistant_interaction',
        '',
      ].join('\n'),
      'utf8',
    );
    const cli = createTestCli({ cwd: override });
    await cli.run('workflows', 'list');
    expect(cli.stdout()).toContain('Team Fast Fix');
    expect(cli.stdout()).toContain('project');
    removeDir(override);
  });

  it('methodologies list shows the 14 built-ins including agentic-agile-light', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('methodologies', 'list');
    const stdout = cli.stdout();
    expect(stdout).toContain('agentic-agile-light');
    expect(stdout).toContain('discovery');
    expect(stdout).toContain('spec-driven');
  });

  it('methodologies explain prints use/avoid guidance', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('methodologies', 'explain', 'spec-driven');
    expect(cli.stdout()).toContain('Use when:');
    expect(cli.stdout()).toContain('Avoid when:');
  });
});
