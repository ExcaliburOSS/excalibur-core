import { afterEach, describe, expect, it } from 'vitest';
import { detectInstructionFiles } from './instruction-files';
import { makeFixtureDir, removeFixtureDir } from './test-utils';

describe('detectInstructionFiles', () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(removeFixtureDir));
  });

  it('classifies every well-known instruction file', async () => {
    const dir = await makeFixtureDir({
      'AGENTS.md': '# Agents',
      'CLAUDE.md': '# Claude',
      '.claude/CLAUDE.md': '# Claude nested',
      '.cursor/rules/backend.md': '# Backend rules',
      '.github/copilot-instructions.md': '# Copilot',
      'README.md': '# Readme',
      'docs/architecture.md': '# Architecture',
      'docs/adr/0001-use-postgres.md': '# ADR 1',
      'adrs/0002-event-sourcing.md': '# ADR 2',
      'GEMINI.md': '# Gemini',
      'docs/testing.md': '# Testing guide',
    });
    fixtures.push(dir);

    const files = await detectInstructionFiles(dir);
    const kindOf = (path: string): string | undefined => files.find((f) => f.path === path)?.kind;

    expect(kindOf('AGENTS.md')).toBe('agents_md');
    expect(kindOf('CLAUDE.md')).toBe('claude_md');
    expect(kindOf('.claude/CLAUDE.md')).toBe('claude_md');
    expect(kindOf('.cursor/rules/backend.md')).toBe('cursor_rules');
    expect(kindOf('.github/copilot-instructions.md')).toBe('copilot_instructions');
    expect(kindOf('README.md')).toBe('readme');
    expect(kindOf('docs/architecture.md')).toBe('architecture_doc');
    expect(kindOf('docs/adr/0001-use-postgres.md')).toBe('adr');
    expect(kindOf('adrs/0002-event-sourcing.md')).toBe('adr');
    expect(kindOf('GEMINI.md')).toBe('other');
    expect(kindOf('docs/testing.md')).toBe('other');
  });

  it('reports each file once with its most specific kind', async () => {
    const dir = await makeFixtureDir({
      'docs/architecture.md': '# Architecture',
      'docs/adr/0001.md': '# ADR',
    });
    fixtures.push(dir);

    const files = await detectInstructionFiles(dir);
    const archEntries = files.filter((f) => f.path === 'docs/architecture.md');
    expect(archEntries).toHaveLength(1);
    expect(archEntries[0]?.kind).toBe('architecture_doc');
    const adrEntries = files.filter((f) => f.path === 'docs/adr/0001.md');
    expect(adrEntries).toHaveLength(1);
    expect(adrEntries[0]?.kind).toBe('adr');
  });

  it('returns an empty list for repositories without instruction files', async () => {
    const dir = await makeFixtureDir({ 'src/index.ts': '// code' });
    fixtures.push(dir);
    expect(await detectInstructionFiles(dir)).toEqual([]);
  });
});
