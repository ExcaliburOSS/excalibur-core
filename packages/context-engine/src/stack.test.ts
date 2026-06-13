import { afterEach, describe, expect, it } from 'vitest';
import { detectStack } from './stack';
import { makeFixtureDir, removeFixtureDir } from './test-utils';

describe('detectStack', () => {
  const fixtures: string[] = [];
  const fixture = async (files: Record<string, string>): Promise<string> => {
    const dir = await makeFixtureDir(files);
    fixtures.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(removeFixtureDir));
  });

  it('detects pnpm from pnpm-lock.yaml', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ name: 'a' }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    });
    expect((await detectStack(dir)).packageManager).toBe('pnpm');
  });

  it('detects yarn, bun and npm from their lockfiles', async () => {
    const yarn = await fixture({ 'package.json': '{}', 'yarn.lock': '' });
    const bun = await fixture({ 'package.json': '{}', 'bun.lockb': '' });
    const npm = await fixture({ 'package.json': '{}', 'package-lock.json': '{}' });
    expect((await detectStack(yarn)).packageManager).toBe('yarn');
    expect((await detectStack(bun)).packageManager).toBe('bun');
    expect((await detectStack(npm)).packageManager).toBe('npm');
  });

  it('falls back to the packageManager field, then to npm', async () => {
    const viaField = await fixture({
      'package.json': JSON.stringify({ name: 'a', packageManager: 'pnpm@9.12.0' }),
    });
    const bare = await fixture({ 'package.json': JSON.stringify({ name: 'a' }) });
    expect((await detectStack(viaField)).packageManager).toBe('pnpm');
    expect((await detectStack(bare)).packageManager).toBe('npm');
  });

  it('returns null package manager for non-Node repositories', async () => {
    const dir = await fixture({ 'go.mod': 'module example.com/demo\n' });
    const stack = await detectStack(dir);
    expect(stack.packageManager).toBeNull();
    expect(stack.languages).toEqual(['go']);
  });

  it('detects typescript via tsconfig and javascript otherwise', async () => {
    const ts = await fixture({ 'package.json': '{}', 'tsconfig.json': '{}' });
    const js = await fixture({ 'package.json': '{}' });
    expect((await detectStack(ts)).languages).toContain('typescript');
    const jsLanguages = (await detectStack(js)).languages;
    expect(jsLanguages).toContain('javascript');
    expect(jsLanguages).not.toContain('typescript');
  });

  it('detects python, rust and java from their marker files', async () => {
    const dir = await fixture({
      'pyproject.toml': '[project]\nname = "demo"\n',
      'Cargo.toml': '[package]\nname = "demo"\n',
      'pom.xml': '<project/>',
    });
    const { languages } = await detectStack(dir);
    expect(languages).toEqual(expect.arrayContaining(['python', 'rust', 'java']));
  });

  it('detects frameworks from dependencies', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({
        dependencies: { react: '^18.0.0', next: '^14.0.0' },
        devDependencies: { prisma: '^5.0.0' },
      }),
    });
    const { frameworks } = await detectStack(dir);
    expect(frameworks).toEqual(expect.arrayContaining(['react', 'next', 'prisma']));
    expect(frameworks).not.toContain('nestjs');
  });

  it('detects frameworks from config-file markers without dependencies', async () => {
    const dir = await fixture({
      'prisma/schema.prisma': 'generator client { provider = "prisma-client-js" }\n',
      'nest-cli.json': '{}',
    });
    const { frameworks } = await detectStack(dir);
    expect(frameworks).toEqual(expect.arrayContaining(['prisma', 'nestjs']));
  });

  it('tolerates malformed package.json', async () => {
    const dir = await fixture({ 'package.json': '{ not json' });
    const stack = await detectStack(dir);
    expect(stack.frameworks).toEqual([]);
    expect(stack.packageManager).toBeNull();
  });
});
