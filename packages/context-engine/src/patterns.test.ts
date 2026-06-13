import { afterEach, describe, expect, it } from 'vitest';
import { detectPatterns } from './patterns';
import { makeFixtureDir, removeFixtureDir } from './test-utils';

describe('detectPatterns', () => {
  const fixtures: string[] = [];
  const fixture = async (files: Record<string, string>): Promise<string> => {
    const dir = await makeFixtureDir(files);
    fixtures.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(removeFixtureDir));
  });

  it('detects sensitive directories and .env* files', async () => {
    const dir = await fixture({
      '.env': 'SECRET=1\n',
      '.env.local': 'SECRET=2\n',
      'src/auth/auth.service.ts': '// auth',
      'src/billing/billing.service.ts': '// billing',
      'config/secrets/keys.yaml': 'key: value\n',
    });
    const { sensitivePaths } = await detectPatterns(dir);
    expect(sensitivePaths).toEqual(
      expect.arrayContaining(['.env', '.env.local', 'src/auth', 'src/billing', 'config/secrets']),
    );
  });

  it('detects test, migration and api directories', async () => {
    const dir = await fixture({
      'tests/app.test.ts': '// test',
      'src/__tests__/unit.test.ts': '// test',
      'db/migrations/0001_init.sql': '-- migration',
      'src/api/routes.ts': '// api',
      'src/controllers/app.controller.ts': '// controller',
    });
    const patterns = await detectPatterns(dir);
    expect(patterns.testDirs).toEqual(expect.arrayContaining(['tests', 'src/__tests__']));
    expect(patterns.migrationDirs).toEqual(['db/migrations']);
    expect(patterns.apiDirs).toEqual(expect.arrayContaining(['src/api', 'src/controllers']));
    expect(patterns.hasBackend).toBe(true);
  });

  it('separates domain modules from infrastructure directories', async () => {
    const dir = await fixture({
      'src/escrow/escrow.service.ts': '// domain',
      'src/contracts/contracts.service.ts': '// domain',
      'src/utils/format.ts': '// infra',
      'src/api/index.ts': '// infra',
      'src/components/Button.tsx': '// frontend infra',
    });
    const patterns = await detectPatterns(dir);
    expect(patterns.domainDirs).toEqual(['src/contracts', 'src/escrow']);
    expect(patterns.hasFrontend).toBe(true);
  });

  it('reports an empty repository as having no patterns', async () => {
    const dir = await fixture({ 'notes.txt': 'hello' });
    const patterns = await detectPatterns(dir);
    expect(patterns).toEqual({
      hasBackend: false,
      hasFrontend: false,
      testDirs: [],
      migrationDirs: [],
      apiDirs: [],
      domainDirs: [],
      sensitivePaths: [],
    });
  });

  it('marks backend repositories via frameworks even without api dirs', async () => {
    const dir = await fixture({
      'package.json': JSON.stringify({ dependencies: { fastify: '^4.0.0' } }),
    });
    const patterns = await detectPatterns(dir);
    expect(patterns.hasBackend).toBe(true);
    expect(patterns.hasFrontend).toBe(false);
  });
});
