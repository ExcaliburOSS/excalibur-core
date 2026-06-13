import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  instructionSourceSchema,
  type InstructionSource,
  type InstructionSourceFormat,
} from '@excalibur/shared';
import { RepoAnalysisError } from '../errors';
import { makeFixtureDir, removeFixtureDir } from '../test-utils';
import { scanInstructionSources } from './scan';

const PROJECT_FILES: Record<string, string> = {
  'CLAUDE.md': '# Project Claude instructions\n\nUse pnpm.\n',
  '.claude/instructions/security.md': '# Security notes\n',
  'AGENTS.md': '# Agent instructions\n',
  'GEMINI.md': '# Gemini instructions\n',
  '.cursor/rules.md': '# Cursor base rules\n',
  '.cursor/rules/backend.md': '# Backend rules\n',
  '.github/copilot-instructions.md': '# Copilot instructions\n',
  '.codex/instructions.md': '# Codex instructions\n',
  '.openai/notes.md': '# OpenAI notes\n',
  '.windsurf/rules.md': '# Windsurf rules\n',
  '.aider.conf.yml': 'auto-commits: false\n',
  '.aiderignore': 'dist/\n',
  'README.md': '# Demo readme\n',
  'CONTRIBUTING.md': '# Contributing\n',
  'docs/testing.md': '# Testing guide\n',
  'adr/0001-use-postgres.md': '# 1. Use Postgres\n',
  'docs/decisions/0002-event-sourcing.md': '# 2. Event sourcing\n',
  'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploys the app\n---\n# Deploy\n',
  '.skills/deploy/SKILL.md': '# Shadow deploy skill\n',
  '.claude/skills/review/SKILL.md': '---\nname: review\n---\n',
  // Noise that must never be detected:
  'src/index.ts': 'export const x = 1;\n',
  'node_modules/pkg/CLAUDE.md': '# dependency claude\n',
  '.env': 'SECRET=1\n',
};

describe('scanInstructionSources', () => {
  let repoRoot: string;
  let homeDir: string;
  let sources: InstructionSource[];

  const byId = (id: string): InstructionSource => {
    const found = sources.find((s) => s.id === id);
    if (!found) {
      throw new Error(`expected source ${id}; got ${sources.map((s) => s.id).join(', ')}`);
    }
    return found;
  };

  beforeAll(async () => {
    repoRoot = await makeFixtureDir(PROJECT_FILES);
    homeDir = await makeFixtureDir({
      '.claude/CLAUDE.md': '# Personal preferences\n\nAlways explain reasoning.\n',
      '.claude/skills/notes/SKILL.md': '---\nname: notes\ndescription: Personal notes skill\n---\n',
    });
    sources = await scanInstructionSources({ repoRoot, homeDir, includeUserGlobal: true });
  });

  afterAll(async () => {
    await removeFixtureDir(repoRoot);
    await removeFixtureDir(homeDir);
  });

  it('classifies every ISD format correctly', () => {
    const expectations: Array<[string, InstructionSourceFormat]> = [
      ['CLAUDE.md', 'claude_md'],
      ['.claude/instructions/security.md', 'claude_md'],
      ['AGENTS.md', 'agents_md'],
      ['GEMINI.md', 'gemini_md'],
      ['.cursor/rules.md', 'cursor_rules'],
      ['.cursor/rules/backend.md', 'cursor_rules'],
      ['.github/copilot-instructions.md', 'copilot_instructions'],
      ['.codex/instructions.md', 'codex'],
      ['.openai/notes.md', 'codex'],
      ['.windsurf/rules.md', 'custom'],
      ['.aider.conf.yml', 'aider'],
      ['.aiderignore', 'aider'],
      ['README.md', 'docs'],
      ['CONTRIBUTING.md', 'docs'],
      ['docs/testing.md', 'docs'],
      ['adr/0001-use-postgres.md', 'adr'],
      ['docs/decisions/0002-event-sourcing.md', 'adr'],
      ['skills/deploy/SKILL.md', 'skill_md'],
      ['.skills/deploy/SKILL.md', 'skill_md'],
      ['.claude/skills/review/SKILL.md', 'skill_md'],
    ];
    for (const [path, format] of expectations) {
      const source = sources.find((s) => s.path === path && s.scope === 'project');
      expect(source, `source for ${path}`).toBeDefined();
      expect(source?.format, path).toBe(format);
    }
  });

  it('never detects noise files or files under ignored directories', () => {
    const paths = sources.map((s) => s.path);
    expect(paths).not.toContain('src/index.ts');
    expect(paths).not.toContain('.env');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('applies DEFAULT_TRUST_RULES: project instructions trusted, docs are context', () => {
    expect(byId('claude-project')).toMatchObject({
      kind: 'instruction',
      trustLevel: 'trusted',
      enabled: true,
      importedAs: 'instruction',
    });
    expect(byId('agents-project').trustLevel).toBe('trusted');
    expect(byId('cursor-backend').trustLevel).toBe('trusted');
    expect(byId('copilot-project').trustLevel).toBe('trusted');
    expect(byId('gemini-project').trustLevel).toBe('trusted');
    expect(byId('docs-readme')).toMatchObject({ kind: 'context', trustLevel: 'trusted' });
    expect(byId('adr-0001-use-postgres')).toMatchObject({ kind: 'context', trustLevel: 'trusted' });
    // Formats without an explicit rule fall back to the conservative default.
    expect(byId('custom-windsurf-rules').trustLevel).toBe('review_required');
    expect(byId('custom-windsurf-rules').enabled).toBe(false);
  });

  it('marks skills review_required and never auto-enables them', () => {
    for (const source of sources.filter((s) => s.format === 'skill_md')) {
      expect(source.kind).toBe('skill');
      expect(source.trustLevel).toBe('review_required');
      expect(source.enabled).toBe(false);
    }
  });

  it('generates stable ids and resolves collisions deterministically', () => {
    expect(byId('claude-project').path).toBe('CLAUDE.md');
    expect(byId('claude-instructions-security').path).toBe('.claude/instructions/security.md');
    expect(byId('cursor-rules').path).toBe('.cursor/rules.md');
    expect(byId('aider-conf').path).toBe('.aider.conf.yml');
    expect(byId('aider-ignore').path).toBe('.aiderignore');
    expect(byId('docs-testing').path).toBe('docs/testing.md');
    // Two skills named `deploy` in different roots: suffix keeps ids unique.
    expect(byId('skill-deploy').format).toBe('skill_md');
    expect(byId('skill-deploy-2').format).toBe('skill_md');
    expect(byId('skill-deploy').path).not.toBe(byId('skill-deploy-2').path);
  });

  it('separates user-global sources from project sources', () => {
    const globalClaude = byId('claude-global');
    expect(globalClaude.scope).toBe('user_global');
    expect(globalClaude.path).toBe('~/.claude/CLAUDE.md');
    expect(globalClaude.trustLevel).toBe('trusted');
    expect(globalClaude.kind).toBe('instruction');

    const globalSkill = byId('skill-notes-global');
    expect(globalSkill.scope).toBe('user_global');
    expect(globalSkill.path).toBe('~/.claude/skills/notes/SKILL.md');
    expect(globalSkill.trustLevel).toBe('review_required');

    const projectScopes = sources.filter((s) => s.scope === 'project');
    expect(projectScopes.every((s) => !s.path.startsWith('~/'))).toBe(true);
  });

  it('skips user-global scanning unless requested', async () => {
    const projectOnly = await scanInstructionSources({
      repoRoot,
      homeDir,
      includeUserGlobal: false,
    });
    expect(projectOnly.every((s) => s.scope === 'project')).toBe(true);

    const bare = await scanInstructionSources({ repoRoot });
    expect(bare.every((s) => s.scope === 'project')).toBe(true);

    // An explicitly injected homeDir implies user-global scanning.
    const implied = await scanInstructionSources({ repoRoot, homeDir });
    expect(implied.some((s) => s.scope === 'user_global')).toBe(true);
  });

  it('computes contentHash as the sha256 of the file content', () => {
    const expected = createHash('sha256').update(PROJECT_FILES['CLAUDE.md'] ?? '', 'utf8').digest('hex');
    expect(byId('claude-project').contentHash).toBe(expected);
    expect(byId('claude-project').contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('extracts titles from headings and front matter', () => {
    expect(byId('claude-project').title).toBe('Project Claude instructions');
    const frontMatterSkill = sources.find((s) => s.path === 'skills/deploy/SKILL.md');
    expect(frontMatterSkill?.title).toBe('deploy');
    expect(byId('aider-ignore').title).toBeNull();
  });

  it('produces sources that validate against the shared zod schema', () => {
    for (const source of sources) {
      expect(() => instructionSourceSchema.parse(source)).not.toThrow();
    }
  });

  it('records absolute paths in metadata for downstream readers', () => {
    expect(byId('claude-project').metadata['absolutePath']).toContain(repoRoot);
    expect(byId('claude-global').metadata['absolutePath']).toContain(homeDir);
  });

  it('throws a RepoAnalysisError for a missing repository root', async () => {
    await expect(
      scanInstructionSources({ repoRoot: '/nonexistent/path/for/excalibur' }),
    ).rejects.toBeInstanceOf(RepoAnalysisError);
  });

  it('tolerates a missing home directory', async () => {
    const result = await scanInstructionSources({
      repoRoot,
      homeDir: '/nonexistent/home/dir',
      includeUserGlobal: true,
    });
    expect(result.every((s) => s.scope === 'project')).toBe(true);
  });
});
