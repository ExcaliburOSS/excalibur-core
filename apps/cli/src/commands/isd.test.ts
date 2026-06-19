import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCli, makeTempDir, makeTempRepo, removeDir } from '../test-utils';

const cleanups: string[] = [];

afterAll(() => {
  for (const dir of cleanups) removeDir(dir);
});

function tempRepo(options: Parameters<typeof makeTempRepo>[0] = {}): string {
  const repo = makeTempRepo({ git: false, ...options });
  cleanups.push(repo);
  return repo;
}

/** Home dir with a user-global CLAUDE.md for `--include-global` scenarios. */
function tempHome(): string {
  const home = makeTempDir('home');
  cleanups.push(home);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Personal prefs\n\nBe terse.\n', 'utf8');
  return home;
}

describe('instructions (ISD spec §7)', () => {
  it('list shows ID/TYPE/SCOPE/TRUST/ENABLED/PATH for detected sources', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('instructions', 'list');
    const stdout = cli.stdout();
    expect(stdout).toContain('claude-project');
    expect(stdout).toContain('claude_md');
    expect(stdout).toContain('project');
    expect(stdout).toContain('trusted');
    expect(stdout).toContain('CLAUDE.md');
  });

  it('shows user-global trust as trusted-local', async () => {
    const repo = tempRepo();
    const home = tempHome();
    const cli = createTestCli({ cwd: repo, homeDir: home, includeUserGlobal: true });
    await cli.run('instructions', 'list');
    expect(cli.stdout()).toContain('trusted-local');
    expect(cli.stdout()).toContain('user_global');
  });

  it('scan prints the grouped detection report', async () => {
    const repo = tempRepo({ skill: true });
    const cli = createTestCli({ cwd: repo });
    await cli.run('instructions', 'scan');
    const stdout = cli.stdout();
    expect(stdout).toContain('Project instructions (used automatically):');
    expect(stdout).toContain('Detected skills (review before enabling):');
  });

  it('enable/disable persist into config.yaml', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('instructions', 'disable', 'claude-project');
    const configPath = join(repo, '.excalibur', 'config.yaml');
    let config = parseYaml(readFileSync(configPath, 'utf8')) as {
      instructions?: { sources?: Array<{ path: string; enabled?: boolean }> };
    };
    const entry = config.instructions?.sources?.find((source) => source.path.includes('CLAUDE.md'));
    expect(entry?.enabled).toBe(false);

    cli.reset();
    await cli.run('instructions', 'list');
    expect(cli.stdout()).toMatch(/claude-project.*no/);

    await cli.run('instructions', 'enable', 'claude-project');
    config = parseYaml(readFileSync(configPath, 'utf8')) as typeof config;
    expect(
      config.instructions?.sources?.find((source) => source.path.includes('CLAUDE.md'))?.enabled,
    ).toBe(true);
  });

  it('inspect shows source details', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('instructions', 'inspect', 'claude-project');
    expect(cli.stdout()).toContain('Format: claude_md');
    expect(cli.stdout()).toContain('Content hash:');
  });

  it('unknown ids are usage errors with guidance', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('instructions', 'inspect', 'nope')).rejects.toThrow(
      /Unknown instruction source/,
    );
  });

  it('import copies a project source into .excalibur/instructions/', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('instructions', 'import', 'claude-project', '--yes');
    expect(existsSync(join(repo, '.excalibur', 'instructions', 'CLAUDE.md'))).toBe(true);
  });

  it('import of a user-global source requires --include-global (bare --yes is NOT enough)', async () => {
    const repo = tempRepo();
    const home = tempHome();
    const cli = createTestCli({ cwd: repo, homeDir: home, includeUserGlobal: true });
    await expect(cli.run('instructions', 'import', 'claude-global', '--yes')).rejects.toThrow(
      /--include-global/,
    );
    expect(existsSync(join(repo, '.excalibur', 'instructions', 'CLAUDE.md'))).toBe(false);

    await cli.run('instructions', 'import', 'claude-global', '--include-global');
    expect(existsSync(join(repo, '.excalibur', 'instructions', 'CLAUDE.md'))).toBe(true);
  });

  it('doctor flags sources that disappear after a scan', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('instructions', 'doctor');
    expect(cli.stdout()).toContain('OK');

    const { rmSync } = await import('node:fs');
    rmSync(join(repo, 'CLAUDE.md'));
    cli.reset();
    await cli.run('instructions', 'doctor');
    expect(cli.stderr()).toContain('MISSING');
  });
});

describe('skills (ISD spec §7)', () => {
  it('lists detected skills with trust level', async () => {
    const repo = tempRepo({ skill: true });
    const cli = createTestCli({ cwd: repo });
    await cli.run('skills', 'list');
    const stdout = cli.stdout();
    expect(stdout).toContain('db-review');
    expect(stdout).toContain('review_required');
    expect(stdout).toContain('no'); // not enabled by default
  });

  it('inspect shows triggers/dependencies/tools', async () => {
    const repo = tempRepo({ skill: true });
    const cli = createTestCli({ cwd: repo });
    const list = createTestCli({ cwd: repo });
    await list.run('skills', 'list', '--json');
    const skills = JSON.parse(list.stdout()) as Array<{ id: string }>;
    const id = skills[0]?.id as string;
    await cli.run('skills', 'inspect', id);
    expect(cli.stdout()).toContain('Triggers:');
    expect(cli.stdout()).toContain('review_required');
  });

  it('enable on a review_required skill requires --accept-risk (--yes alone fails)', async () => {
    const repo = tempRepo({ skill: true });
    const list = createTestCli({ cwd: repo });
    await list.run('skills', 'list', '--json');
    const skills = JSON.parse(list.stdout()) as Array<{ id: string }>;
    const id = skills[0]?.id as string;

    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('skills', 'enable', id, '--yes')).rejects.toThrow(/--accept-risk/);

    await cli.run('skills', 'enable', id, '--accept-risk');
    const config = parseYaml(readFileSync(join(repo, '.excalibur', 'config.yaml'), 'utf8')) as {
      skills?: { sources?: Array<{ path: string; enabled?: boolean; trustLevel?: string }> };
    };
    const entry = config.skills?.sources?.find((source) => source.path.includes('SKILL.md'));
    expect(entry?.enabled).toBe(true);
    expect(entry?.trustLevel).toBe('review_required');
  });

  it('disable persists enabled: false', async () => {
    const repo = tempRepo({ skill: true });
    const list = createTestCli({ cwd: repo });
    await list.run('skills', 'list', '--json');
    const skills = JSON.parse(list.stdout()) as Array<{ id: string }>;
    const id = skills[0]?.id as string;

    const cli = createTestCli({ cwd: repo });
    await cli.run('skills', 'disable', id);
    const config = parseYaml(readFileSync(join(repo, '.excalibur', 'config.yaml'), 'utf8')) as {
      skills?: { sources?: Array<{ path: string; enabled?: boolean }> };
    };
    expect(
      config.skills?.sources?.find((source) => source.path.includes('SKILL.md'))?.enabled,
    ).toBe(false);
  });
});
