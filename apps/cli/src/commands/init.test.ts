import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

const cleanups: string[] = [];

afterAll(() => {
  for (const dir of cleanups) removeDir(dir);
});

function tempRepo(): string {
  // init tests assert the EXACT generated file set — start without the test
  // fixture's explicit mock providers.yaml so init owns every file under .excalibur.
  const repo = makeTempRepo({ mockProvider: false });
  cleanups.push(repo);
  return repo;
}

describe('init (onboarding spec §1–§3, §12)', () => {
  it('minimal mode generates ONLY the minimal file set', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('init', '--yes');

    const base = join(repo, '.excalibur');
    expect(existsSync(join(base, 'config.yaml'))).toBe(true);
    expect(existsSync(join(base, 'instructions', 'general.md'))).toBe(true);
    expect(existsSync(join(base, 'extensions.yaml'))).toBe(true);
    // --yes skips provider setup ("configure later") — the built-in mock is
    // the runtime default, so minimal init writes exactly three files.
    expect(existsSync(join(base, 'models', 'providers.yaml'))).toBe(false);

    // No catalogs are exported in minimal mode (built-ins work without files).
    expect(existsSync(join(base, 'workflows'))).toBe(false);
    expect(existsSync(join(base, 'methodologies'))).toBe(false);
    expect(existsSync(join(base, 'policies'))).toBe(false);

    const config = parseYaml(readFileSync(join(base, 'config.yaml'), 'utf8')) as {
      safety?: { preset?: string };
      commands?: Record<string, string>;
      workflowDefaults?: Record<string, string>;
      autonomyDefaults?: Record<string, number>;
    };
    expect(config.safety?.preset).toBe('standard-safe');
    // Detected commands only — never invented.
    expect(config.commands?.test).toBe('pnpm test');
    expect(config.workflowDefaults?.ask).toBe('ask-repo');
    expect(config.autonomyDefaults?.review).toBe(0);

    const stdout = cli.stdout();
    expect(stdout).toContain('Detected:');
    expect(stdout).toContain('Safety: standard-safe');
    expect(stdout).toContain('Try now:');
    expect(stdout).toContain('excalibur review --diff');
  });

  it('references detected instruction sources in config.yaml', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('init', '--yes');
    const config = parseYaml(readFileSync(join(repo, '.excalibur', 'config.yaml'), 'utf8')) as {
      instructions?: { sources?: Array<{ path: string; enabled?: boolean }> };
    };
    const paths = (config.instructions?.sources ?? []).map((source) => source.path);
    expect(paths).toContain('./CLAUDE.md');
    expect(cli.stdout()).toContain('Using existing instructions:');
  });

  it('never overwrites silently: update mode skips existing files', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('init', '--yes');

    const configPath = join(repo, '.excalibur', 'config.yaml');
    writeFileSync(configPath, '# user-edited\nversion: 1\n', 'utf8');

    cli.reset();
    await cli.run('init', '--yes');
    expect(readFileSync(configPath, 'utf8')).toContain('# user-edited');
    expect(cli.stdout()).toContain('Skipped');
  });

  it('--force overwrites after the update-mode confirmation', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('init', '--yes');
    const configPath = join(repo, '.excalibur', 'config.yaml');
    writeFileSync(configPath, '# user-edited\nversion: 1\n', 'utf8');
    await cli.run('init', '--yes', '--force');
    expect(readFileSync(configPath, 'utf8')).not.toContain('# user-edited');
  });

  it('--team adds instructions, policies and model routing', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('init', '--team', '--yes');
    const base = join(repo, '.excalibur');
    for (const file of [
      'instructions/architecture.md',
      'instructions/testing.md',
      'instructions/security.md',
      'policies/standard-safe.yaml',
      'policies/sensitive-paths.yaml',
      'models/providers.yaml',
      'models/routing.yaml',
    ]) {
      expect(existsSync(join(base, file)), `${file} must exist`).toBe(true);
    }
  });

  it('--full exports the complete built-in catalogs (14 + 14)', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('init', '--full', '--yes');
    const base = join(repo, '.excalibur');
    expect(readdirSync(join(base, 'workflows')).length).toBe(14);
    expect(readdirSync(join(base, 'methodologies')).length).toBe(14);
    expect(existsSync(join(base, 'question-packs'))).toBe(true);
    expect(existsSync(join(base, 'reports'))).toBe(true);
  });

  it('rejects --team together with --full', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('init', '--team', '--full', '--yes')).rejects.toThrow(/either --team or --full/);
  });
});

describe('doctor (ONB-9)', () => {
  it('passes on an initialized repository', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('init', '--yes');
    cli.reset();
    await cli.run('doctor');
    const stdout = cli.stdout();
    expect(stdout).toContain('PASS');
    expect(stdout).toContain('safety preset');
    expect(stdout).not.toContain('FAIL');
  });

  it('fails (exit 1 semantics) on a broken config.yaml', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('init', '--yes');
    writeFileSync(join(repo, '.excalibur', 'config.yaml'), 'version: "not a number"\n', 'utf8');
    cli.reset();
    await expect(cli.run('doctor')).rejects.toThrow(/failing check/);
    expect(cli.stdout()).toContain('FAIL');
  });
});

describe('models (onboarding §4)', () => {
  it('models list shows the mock default when nothing is configured', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('models', 'list');
    expect(cli.stdout()).toContain('mock');
    expect(cli.stdout()).toContain('ready (built-in)');
  });

  it('models setup --yes writes providers.yaml with the mock provider', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('models', 'setup', '--yes');
    const providersPath = join(repo, '.excalibur', 'models', 'providers.yaml');
    const providers = parseYaml(readFileSync(providersPath, 'utf8')) as {
      providers: { default?: string; mock?: { type?: string } };
    };
    expect(providers.providers.default).toBe('mock');
    expect(providers.providers.mock?.type).toBe('mock');
  });

  it('flags a configured real provider as ready and names its key env var', async () => {
    const repo = tempRepo();
    const providersDir = join(repo, '.excalibur', 'models');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(
      join(providersDir, 'providers.yaml'),
      ['providers:', '  default: qwen', '  qwen:', '    type: openai-compatible', '    baseUrl: https://example.com/v1', '    apiKeyEnv: QWEN_API_KEY', '  mock:', '    type: mock', ''].join('\n'),
      'utf8',
    );
    const cli = createTestCli({ cwd: repo });
    await cli.run('models', 'list');
    // Real providers execute in M2: ready once the key env var is set.
    expect(cli.stdout()).toContain('ready · set QWEN_API_KEY');
    expect(cli.stdout()).not.toContain('available in M2');
    // The key VALUE never appears — only the env var NAME.
    expect(cli.stdout()).toContain('QWEN_API_KEY');
  });
});
