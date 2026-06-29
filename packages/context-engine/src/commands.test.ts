import { afterEach, describe, expect, it } from 'vitest';
import { detectCommands } from './commands';
import { makeFixtureDir, removeFixtureDir } from './test-utils';

describe('detectCommands', () => {
  const fixtures: string[] = [];
  const fixture = async (files: Record<string, string>): Promise<string> => {
    const dir = await makeFixtureDir(files);
    fixtures.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(removeFixtureDir));
  });

  it('maps npm scripts through the detected package manager (pnpm)', async () => {
    const dir = await fixture({
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'package.json': JSON.stringify({
        scripts: {
          test: 'vitest',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          build: 'tsup',
        },
      }),
    });
    expect(await detectCommands(dir)).toEqual({
      test: 'pnpm test',
      lint: 'pnpm run lint',
      typecheck: 'pnpm run typecheck',
      build: 'pnpm run build',
    });
  });

  it('defaults to npm when no lockfile or packageManager field exists', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ scripts: { test: 'jest', build: 'tsc' } }),
    });
    expect(await detectCommands(dir)).toEqual({ test: 'npm test', build: 'npm run build' });
  });

  it('always uses `bun run` to avoid the built-in bun test runner', async () => {
    const dir = await fixture({
      'bun.lockb': '',
      'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }),
    });
    expect(await detectCommands(dir)).toEqual({
      test: 'bun run test',
      lint: 'bun run lint',
    });
  });

  it('accepts the type-check alias for typecheck', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ scripts: { 'type-check': 'tsc --noEmit' } }),
    });
    expect(await detectCommands(dir)).toEqual({ typecheck: 'npm run type-check' });
  });

  it('omits undetectable commands instead of inventing them', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ scripts: { clean: 'rimraf dist' } }),
    });
    expect(await detectCommands(dir)).toEqual({});
  });

  it('detects a dev/preview server script as the dev command (RUN-FIX-21)', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
    });
    expect(await detectCommands(dir)).toEqual({ dev: 'npm run start' });
  });

  it('returns no commands without a package.json', async () => {
    const dir = await fixture({ 'go.mod': 'module demo\n' });
    expect(await detectCommands(dir)).toEqual({});
  });
});
