import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from '@excalibur/extension-runtime';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DECLARATIVE_SCAFFOLD_TYPES,
  PROGRAMMATIC_SCAFFOLD_TYPES,
  scaffoldExtension,
} from '../lib/scaffold';
import { validateRepoExtensions } from '../lib/validate-extensions';
import { createTestCli, makeTempDir, makeTempRepo, removeDir } from '../test-utils';

const cleanups: string[] = [];

afterAll(() => {
  for (const dir of cleanups) removeDir(dir);
});

function tempRepo(): string {
  const repo = makeTempRepo({ git: false });
  cleanups.push(repo);
  return repo;
}

describe('extensions create (scaffold generators, extensions spec §9)', () => {
  it('scaffolds every declarative type and all of them validate', () => {
    const repo = tempRepo();
    const targetDir = join(repo, '.excalibur', 'extensions');
    for (const [index, type] of DECLARATIVE_SCAFFOLD_TYPES.entries()) {
      const name = `sample-${type}-${index}`;
      const result = scaffoldExtension(targetDir, type, name);
      expect(result.kind).toBe('declarative');
      expect(existsSync(join(result.dir, 'excalibur.extension.yaml'))).toBe(true);
      expect(existsSync(join(result.dir, 'README.md'))).toBe(true);

      const manifest = validateManifest(
        parseYaml(readFileSync(join(result.dir, 'excalibur.extension.yaml'), 'utf8')),
      );
      expect(manifest.success, `${type} manifest must validate`).toBe(true);
      expect(manifest.data?.kind).toBe('declarative');
    }

    const report = validateRepoExtensions(repo);
    expect(report.errors).toEqual([]);
    // 10 manifests + 10 declarative bodies.
    expect(report.checked.length).toBe(20);
  });

  it('scaffolds every programmatic type with SDK entrypoint files', () => {
    const repo = tempRepo();
    const targetDir = join(repo, '.excalibur', 'extensions');
    for (const type of PROGRAMMATIC_SCAFFOLD_TYPES) {
      const name = `prog-${type}`;
      const result = scaffoldExtension(targetDir, type, name);
      expect(result.kind).toBe('programmatic');
      for (const file of ['excalibur.extension.yaml', 'package.json', 'tsconfig.json', 'src/index.ts', 'README.md']) {
        expect(existsSync(join(result.dir, file)), `${type}/${file} must exist`).toBe(true);
      }
      const manifest = validateManifest(
        parseYaml(readFileSync(join(result.dir, 'excalibur.extension.yaml'), 'utf8')),
      );
      expect(manifest.success).toBe(true);
      expect(manifest.data?.entrypoint).toBe('dist/index.js');
      expect(readFileSync(join(result.dir, 'src', 'index.ts'), 'utf8')).toContain('defineExtension');
    }
    const report = validateRepoExtensions(repo);
    expect(report.errors).toEqual([]);
  });

  it('a scaffolded methodology shows up in methodologies list (spec §9 demo)', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('extensions', 'create', 'methodology', 'spike-driven');
    cli.reset();
    await cli.run('methodologies', 'list');
    expect(cli.stdout()).toContain('spike-driven');
    // Scaffolded declarative packs are project-level content (spec §7).
    expect(cli.stdout()).toContain('project');
  });

  it('a scaffolded workflow is runnable via --workflow (spec §9 demo)', async () => {
    const repo = makeTempRepo();
    cleanups.push(repo);
    const cli = createTestCli({ cwd: repo });
    await cli.run('extensions', 'create', 'workflow', 'safe-hotfix');
    cli.reset();
    await cli.run('run', 'Fix webhook retry handling bug', '--workflow', 'safe-hotfix', '--yes');
    expect(cli.stdout()).toContain('Using: Safe Hotfix (safe-hotfix)');
    expect(cli.stdout()).toContain('run completed');
  });

  it('rejects unknown types and duplicate names (usage errors)', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('extensions', 'create', 'nonsense', 'thing')).rejects.toThrow(/Unknown extension type/);
    await cli.run('extensions', 'create', 'workflow', 'dupe');
    await expect(cli.run('extensions', 'create', 'workflow', 'dupe')).rejects.toThrow(/already exists/);
    await expect(cli.run('extensions', 'create', 'workflow', 'Bad Name')).rejects.toThrow(/lowercase/);
  });
});

describe('extensions validate / list / enable / disable / install', () => {
  it('list shows built-in packs with their source', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('extensions', 'list');
    expect(cli.stdout()).toContain('core-workflows');
    expect(cli.stdout()).toContain('core-methodologies');
    expect(cli.stdout()).toContain('built_in');
  });

  it('list --json is machine readable', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('extensions', 'list', '--json');
    const parsed = JSON.parse(cli.stdout()) as { extensions: Array<{ id: string }> };
    expect(parsed.extensions.map((extension) => extension.id)).toContain('discovery-pack');
  });

  it('validate reports readable errors and fails on invalid files', async () => {
    const repo = tempRepo();
    const workflowsDir = join(repo, '.excalibur', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(workflowsDir, 'broken.yaml'), 'id: broken\nname: Broken\n# missing mode/phases\n', 'utf8');
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('extensions', 'validate')).rejects.toThrow(/invalid file/);
    expect(cli.stderr()).toContain('broken.yaml');
  });

  it('enable/disable edit .excalibur/extensions.yaml', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('extensions', 'disable', 'discovery-pack');
    const extensionsPath = join(repo, '.excalibur', 'extensions.yaml');
    let parsed = parseYaml(readFileSync(extensionsPath, 'utf8')) as { disabled?: string[]; enabled?: string[] };
    expect(parsed.disabled).toContain('discovery-pack');

    cli.reset();
    await cli.run('extensions', 'list');
    expect(cli.stdout()).not.toContain('discovery-pack');

    await cli.run('extensions', 'enable', 'discovery-pack');
    parsed = parseYaml(readFileSync(extensionsPath, 'utf8')) as { disabled?: string[]; enabled?: string[] };
    expect(parsed.disabled ?? []).not.toContain('discovery-pack');
    expect(parsed.enabled).toContain('discovery-pack');
  });

  it('install copies a valid local extension into .excalibur/extensions/', async () => {
    const repo = tempRepo();
    const source = makeTempDir('ext-src');
    cleanups.push(source);
    scaffoldExtension(source, 'question-pack', 'risk-pack');

    const cli = createTestCli({ cwd: repo });
    await cli.run('extensions', 'install', join(source, 'risk-pack'), '--yes');
    expect(existsSync(join(repo, '.excalibur', 'extensions', 'risk-pack', 'excalibur.extension.yaml'))).toBe(true);

    // Installed pack participates in validation.
    const report = validateRepoExtensions(repo);
    expect(report.errors).toEqual([]);
  });

  it('install prints an honest M8 notice for non-local sources', async () => {
    const repo = tempRepo();
    const cli = createTestCli({ cwd: repo });
    await cli.run('extensions', 'install', '@excalibur-ext/linear');
    expect(cli.stdout()).toContain('M8');
  });

  it('doctor flags unbuilt programmatic entrypoints', async () => {
    const repo = tempRepo();
    scaffoldExtension(join(repo, '.excalibur', 'extensions'), 'tool', 'db-query');
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('extensions', 'doctor')).rejects.toThrow(/load error/);
    expect(cli.stderr()).toContain('db-query');
  });
});
