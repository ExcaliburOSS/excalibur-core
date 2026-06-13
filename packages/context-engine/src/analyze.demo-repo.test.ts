import { beforeAll, describe, expect, it } from 'vitest';
import { instructionSourceSchema, detectedSkillSchema } from '@excalibur/shared';
import { analyzeRepository } from './analyze';
import { demoRepoDir } from './test-utils';
import type { RepoAnalysis } from './types';

/**
 * Integration test against the owned fixture `examples/demo-repo`
 * (quickcontract-api — fake NestJS + Prisma project, Build Contract §4.5).
 */
describe('analyzeRepository(examples/demo-repo)', () => {
  let analysis: RepoAnalysis;

  beforeAll(async () => {
    analysis = await analyzeRepository(demoRepoDir());
  });

  it('detects TypeScript, NestJS and Prisma with pnpm', () => {
    expect(analysis.languages).toContain('typescript');
    expect(analysis.frameworks).toEqual(expect.arrayContaining(['nestjs', 'prisma']));
    expect(analysis.packageManager).toBe('pnpm');
  });

  it('extracts the npm scripts as pnpm commands', () => {
    expect(analysis.commands).toEqual({
      test: 'pnpm test',
      lint: 'pnpm run lint',
      typecheck: 'pnpm run typecheck',
      build: 'pnpm run build',
    });
  });

  it('detects the instruction files with their kinds', () => {
    const kindOf = (path: string): string | undefined =>
      analysis.instructionFiles.find((f) => f.path === path)?.kind;
    expect(kindOf('AGENTS.md')).toBe('agents_md');
    expect(kindOf('CLAUDE.md')).toBe('claude_md');
    expect(kindOf('.cursor/rules/backend.md')).toBe('cursor_rules');
    expect(kindOf('README.md')).toBe('readme');
  });

  it('detects backend patterns, migrations, tests and domain modules', () => {
    expect(analysis.patterns.hasBackend).toBe(true);
    expect(analysis.patterns.testDirs).toContain('test');
    expect(analysis.patterns.migrationDirs).toContain('prisma/migrations');
    expect(analysis.patterns.domainDirs).toEqual(
      expect.arrayContaining(['src/contracts', 'src/escrow']),
    );
  });

  it('flags .env.example as a sensitive path', () => {
    expect(analysis.patterns.sensitivePaths).toContain('.env.example');
  });

  it('suggests a non-empty, risk-aware workflow list', () => {
    expect(analysis.suggestedWorkflows.length).toBeGreaterThan(0);
    expect(analysis.suggestedWorkflows).toEqual(
      expect.arrayContaining(['fast-fix', 'standard-feature', 'migration', 'security-review']),
    );
  });

  it('scans the instruction sources with stable ids and trust defaults', () => {
    const byId = new Map(analysis.instructionSources.map((s) => [s.id, s]));
    expect(byId.get('claude-project')).toMatchObject({
      format: 'claude_md',
      scope: 'project',
      trustLevel: 'trusted',
      enabled: true,
      path: 'CLAUDE.md',
    });
    expect(byId.get('agents-project')).toMatchObject({ format: 'agents_md', enabled: true });
    expect(byId.get('cursor-backend')).toMatchObject({
      format: 'cursor_rules',
      path: '.cursor/rules/backend.md',
    });
    expect(byId.get('docs-readme')).toMatchObject({ format: 'docs', kind: 'context' });
    for (const source of analysis.instructionSources) {
      expect(() => instructionSourceSchema.parse(source)).not.toThrow();
      expect(source.scope).toBe('project'); // homeDir scanning is off by default
    }
  });

  it('detects the testing skill, parsed but not auto-enabled', () => {
    expect(analysis.skills).toHaveLength(1);
    const skill = analysis.skills[0];
    expect(skill).toMatchObject({
      id: 'skill-testing',
      name: 'testing',
      path: '.claude/skills/testing/SKILL.md',
      scope: 'project',
      trustLevel: 'review_required',
      enabled: false,
    });
    expect(skill?.description).toMatch(/jest/i);
    expect(skill?.triggers.length).toBeGreaterThan(0);
    expect(skill?.dependencies).toContain('jest');
    expect(skill?.toolsRequired).toContain('run_tests');
    expect(() => detectedSkillSchema.parse(skill)).not.toThrow();
  });
});
