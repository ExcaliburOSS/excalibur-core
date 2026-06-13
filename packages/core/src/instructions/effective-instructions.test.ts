import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import {
  EffectiveInstructionBuilder,
  INSTRUCTION_SOURCE_CHAR_CAP,
  SUMMARIZED_MARKER,
} from './effective-instructions';

describe('EffectiveInstructionBuilder', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  function write(relPath: string, content: string): void {
    const filePath = join(repoRoot, ...relPath.split('/'));
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }

  function builder(): EffectiveInstructionBuilder {
    return new EffectiveInstructionBuilder({ repoRoot });
  }

  it('returns empty markdown for a repository without instructions', async () => {
    const result = await builder().build({ repositoryPath: repoRoot });
    expect(result.instructionsMarkdown).toBe('');
    expect(result.sources).toEqual([]);
  });

  it('orders sources by precedence: .excalibur config > repo instructions > docs', async () => {
    write('.excalibur/instructions/general.md', '# General\nUse the project conventions.');
    write('CLAUDE.md', '# Claude guidance\nKeep services small.');
    write('AGENTS.md', '# Agent guidance\nRun typecheck before done.');
    write('docs/architecture.md', '# Architecture\nHexagonal-ish.');

    const result = await builder().build({ repositoryPath: repoRoot });
    const ids = result.sources.map((source) => source.id);

    expect(ids[0]).toBe('excalibur-general');
    expect(ids.indexOf('claude-project')).toBeGreaterThan(0);
    const docsIndex = result.sources.findIndex((source) => source.kind === 'context');
    expect(docsIndex).toBeGreaterThan(ids.indexOf('claude-project'));

    // Per-source headers (ISD spec §8).
    expect(result.instructionsMarkdown).toContain('Effective project instructions:');
    expect(result.instructionsMarkdown).toContain('[Source: CLAUDE.md]');
    expect(result.instructionsMarkdown).toContain('[Source: AGENTS.md]');
    expect(result.instructionsMarkdown).toContain('Keep services small.');
  });

  it('dedupes overlapping files by content hash (highest precedence wins)', async () => {
    const shared = '# Shared\nIdentical content in two files.';
    write('CLAUDE.md', shared);
    write('docs/copy.md', shared);

    const result = await builder().build({ repositoryPath: repoRoot });
    const paths = result.sources.map((source) => source.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).not.toContain('docs/copy.md');
  });

  it('redacts secrets from instruction content', async () => {
    // Assembled at runtime so the fixture holds no contiguous secret-shaped literal.
    const fakeKey = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456';
    write('CLAUDE.md', `Use apiKey: ${fakeKey} for the gateway.`);
    const result = await builder().build({ repositoryPath: repoRoot });
    expect(result.instructionsMarkdown).not.toContain(fakeKey);
    expect(result.instructionsMarkdown).toContain('[REDACTED]');
  });

  it('excludes review_required skills and includes explicitly trusted+enabled ones', async () => {
    write(
      '.claude/skills/testing/SKILL.md',
      ['---', 'name: testing', 'description: Test helper skill', '---', '# Testing skill'].join('\n'),
    );

    const excluded = await builder().build({ repositoryPath: repoRoot });
    expect(excluded.sources.some((source) => source.kind === 'skill')).toBe(false);

    // enabledSkills alone is NOT enough for a review_required skill.
    const stillExcluded = await builder().build({
      repositoryPath: repoRoot,
      enabledSkills: ['skill-testing'],
    });
    expect(stillExcluded.sources.some((source) => source.kind === 'skill')).toBe(false);

    // The config can mark the skill trusted + enabled → included.
    write(
      '.excalibur/config.yaml',
      [
        'skills:',
        '  sources:',
        "    - path: './.claude/skills/testing/SKILL.md'",
        '      scope: project',
        '      enabled: true',
        '      trustLevel: trusted',
      ].join('\n'),
    );
    const included = await builder().build({ repositoryPath: repoRoot });
    const skill = included.sources.find((source) => source.kind === 'skill');
    expect(skill).toBeDefined();
    expect(included.instructionsMarkdown).toContain('enabled skill');
  });

  it('respects config-level enabled: false for instruction sources', async () => {
    write('CLAUDE.md', '# Claude guidance');
    write('AGENTS.md', '# Agent guidance');
    write(
      '.excalibur/config.yaml',
      ['instructions:', '  sources:', "    - path: './AGENTS.md'", '      enabled: false'].join('\n'),
    );

    const result = await builder().build({ repositoryPath: repoRoot });
    const paths = result.sources.map((source) => source.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).not.toContain('AGENTS.md');
  });

  it('records a package-manager conflict warning instead of silently resolving', async () => {
    write('CLAUDE.md', 'Always run npm test before committing.');
    write('.excalibur/config.yaml', ['commands:', '  test: pnpm test'].join('\n'));

    const result = await builder().build({ repositoryPath: repoRoot });
    const conflict = result.warnings.find((warning) => warning.includes('Package-manager conflict'));
    expect(conflict).toBeDefined();
    expect(conflict).toContain('CLAUDE.md');
    expect(conflict).toContain('npm');
    expect(conflict).toContain('pnpm');
  });

  it('caps oversized sources with a summarized marker and warning', async () => {
    write('CLAUDE.md', `# Big\n${'lorem ipsum dolor sit amet '.repeat(400)}`);
    const result = await builder().build({ repositoryPath: repoRoot });
    expect(result.instructionsMarkdown).toContain(SUMMARIZED_MARKER);
    expect(result.instructionsMarkdown.length).toBeLessThan(
      INSTRUCTION_SOURCE_CHAR_CAP + 500,
    );
    expect(result.warnings.some((warning) => warning.includes('per-source cap'))).toBe(true);
  });

  it('caps the total context and reports omitted sources', async () => {
    // Seven 4k sources exceed the 24k total cap.
    write('CLAUDE.md', `# A\n${'a'.repeat(5000)}`);
    write('AGENTS.md', `# B\n${'b'.repeat(5000)}`);
    write('GEMINI.md', `# C\n${'c'.repeat(5000)}`);
    write('docs/a.md', `# D\n${'d'.repeat(5000)}`);
    write('docs/b.md', `# E\n${'e'.repeat(5000)}`);
    write('docs/c.md', `# F\n${'f'.repeat(5000)}`);
    write('docs/d.md', `# G\n${'g'.repeat(5000)}`);

    const result = await builder().build({ repositoryPath: repoRoot });
    expect(result.instructionsMarkdown.length).toBeLessThanOrEqual(24000 + 200);
    expect(
      result.warnings.some((warning) => warning.includes('Total instruction context cap')),
    ).toBe(true);
    expect(result.sources.length).toBeLessThan(7);
  });

  it('includes workflow-specific instruction files only for the matching workflow', async () => {
    write('.excalibur/instructions/general.md', '# General');
    write('.excalibur/instructions/fast-fix.md', '# Fast fix specifics');

    const without = await builder().build({ repositoryPath: repoRoot });
    expect(without.sources.map((source) => source.id)).not.toContain('excalibur-fast-fix');

    const withWorkflow = await builder().build({
      repositoryPath: repoRoot,
      workflowId: 'fast-fix',
    });
    expect(withWorkflow.sources.map((source) => source.id)).toContain('excalibur-fast-fix');

    const otherWorkflow = await builder().build({
      repositoryPath: repoRoot,
      workflowId: 'migration',
    });
    expect(otherWorkflow.sources.map((source) => source.id)).not.toContain('excalibur-fast-fix');
  });
});
