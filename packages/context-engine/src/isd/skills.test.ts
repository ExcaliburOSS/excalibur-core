import { afterEach, describe, expect, it } from 'vitest';
import { detectedSkillSchema } from '@excalibur/shared';
import { makeFixtureDir, removeFixtureDir } from '../test-utils';
import { detectSkills, parseSkillMd } from './skills';

describe('parseSkillMd', () => {
  it('parses a fully specified front-matter skill', () => {
    const content = [
      '---',
      'name: testing',
      'description: Write and run Jest tests safely.',
      'when-to-use:',
      '  - Adding service logic',
      '  - Fixing a bug that needs a regression test',
      'dependencies:',
      '  - jest',
      '  - ts-jest',
      'tools:',
      '  - run_tests',
      '  - read_file',
      '---',
      '',
      '# Testing skill',
      '',
      '## Instructions',
      '',
      '1. Co-locate specs.',
    ].join('\n');

    const parsed = parseSkillMd(content, '.claude/skills/testing/SKILL.md');
    expect(parsed.sourcePath).toBe('.claude/skills/testing/SKILL.md');
    expect(parsed.name).toBe('testing');
    expect(parsed.description).toBe('Write and run Jest tests safely.');
    expect(parsed.triggers).toEqual([
      'Adding service logic',
      'Fixing a bug that needs a regression test',
    ]);
    expect(parsed.dependencies).toEqual(['jest', 'ts-jest']);
    expect(parsed.toolsRequired).toEqual(['run_tests', 'read_file']);
    expect(parsed.instructions).toContain('Co-locate specs.');
  });

  it('falls back to markdown headings when there is no front matter', () => {
    const content = [
      '# Deploy helper',
      '',
      'Automates blue/green deploys for the API.',
      '',
      '## When to use',
      '',
      '- Shipping a release',
      '- Rolling back a bad deploy',
      '',
      '## Dependencies',
      '',
      '- kubectl',
      '',
      '## Required tools',
      '',
      '- run_command',
    ].join('\n');

    const parsed = parseSkillMd(content, 'skills/deploy/SKILL.md');
    expect(parsed.name).toBe('Deploy helper');
    expect(parsed.description).toBe('Automates blue/green deploys for the API.');
    expect(parsed.triggers).toEqual(['Shipping a release', 'Rolling back a bad deploy']);
    expect(parsed.dependencies).toEqual(['kubectl']);
    expect(parsed.toolsRequired).toEqual(['run_command']);
  });

  it('accepts scalar when-to-use values and malformed front matter', () => {
    const scalar = parseSkillMd(
      '---\nname: solo\nwhen-to-use: Only on Fridays\n---\n',
      'skills/solo/SKILL.md',
    );
    expect(scalar.triggers).toEqual(['Only on Fridays']);

    const malformed = parseSkillMd(
      '---\nname: [unclosed\n---\n# Recovered title\n',
      'skills/broken/SKILL.md',
    );
    expect(malformed.name).toBe('Recovered title');
  });

  it('returns null/empty fields for unparseable content without throwing', () => {
    for (const content of ['', '   \n\n', 'just some prose without structure?']) {
      const parsed = parseSkillMd(content, 'skills/opaque/SKILL.md');
      expect(parsed.name).toBeNull();
      expect(parsed.triggers).toEqual([]);
      expect(parsed.dependencies).toEqual([]);
      expect(parsed.toolsRequired).toEqual([]);
      expect(parsed.instructions).toBeNull();
    }
  });
});

describe('detectSkills', () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(removeFixtureDir));
  });

  it('detects skills across roots, with graceful fallbacks, never enabled', async () => {
    const repoRoot = await makeFixtureDir({
      '.claude/skills/testing/SKILL.md':
        '---\nname: testing\ndescription: Test things\nwhen-to-use:\n  - When testing\n---\n',
      'skills/opaque/SKILL.md': '- raw bullet, no headings or front matter\n',
      'src/index.ts': '// not a skill',
    });
    fixtures.push(repoRoot);

    const skills = await detectSkills({ repoRoot });
    expect(skills).toHaveLength(2);

    const testing = skills.find((s) => s.id === 'skill-testing');
    expect(testing).toMatchObject({
      name: 'testing',
      description: 'Test things',
      triggers: ['When testing'],
      scope: 'project',
      trustLevel: 'review_required',
      enabled: false,
    });
    expect(testing?.path).toBe('.claude/skills/testing/SKILL.md');
    expect(testing?.source.format).toBe('skill_md');

    // Unparseable SKILL.md: still detected, named after its directory.
    const opaque = skills.find((s) => s.id === 'skill-opaque');
    expect(opaque).toMatchObject({
      name: 'opaque',
      description: null,
      triggers: [],
      dependencies: [],
      toolsRequired: [],
      enabled: false,
    });

    for (const skill of skills) {
      expect(() => detectedSkillSchema.parse(skill)).not.toThrow();
    }
  });

  it('separates user-global skills via the injectable homeDir', async () => {
    const repoRoot = await makeFixtureDir({ 'README.md': '# Demo' });
    const homeDir = await makeFixtureDir({
      '.claude/skills/notes/SKILL.md': '---\nname: notes\n---\n',
    });
    fixtures.push(repoRoot, homeDir);

    const withGlobal = await detectSkills({ repoRoot, homeDir, includeUserGlobal: true });
    expect(withGlobal).toHaveLength(1);
    expect(withGlobal[0]).toMatchObject({
      id: 'skill-notes-global',
      scope: 'user_global',
      path: '~/.claude/skills/notes/SKILL.md',
      trustLevel: 'review_required',
      enabled: false,
    });

    const projectOnly = await detectSkills({ repoRoot, homeDir, includeUserGlobal: false });
    expect(projectOnly).toHaveLength(0);
  });
});
