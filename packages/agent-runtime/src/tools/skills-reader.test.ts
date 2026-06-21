import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkillIndex, parseSkillFile, readSkillBody } from './skills-reader';

/** P1.8b — self-contained SKILL.md reader for the `skill` tool. */

describe('skills-reader', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'exc-skills-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writeSkill(base: string, name: string, content: string): string {
    const d = join(root, base, name);
    mkdirSync(d, { recursive: true });
    const p = join(d, 'SKILL.md');
    writeFileSync(p, content, 'utf8');
    return p;
  }

  it('discovers skills under skills/ .skills/ and .claude/skills/', () => {
    writeSkill('skills', 'deploy', '---\nname: deploy\ndescription: Deploys the app\n---\nRun it.');
    writeSkill('.skills', 'lint', '---\nname: lint\ndescription: Lints code\n---\nlint it');
    writeSkill('.claude/skills', 'review', '---\nname: review\ndescription: Reviews\n---\nreview');
    const skills = loadSkillIndex([root]);
    expect(skills.map((s) => s.name).sort()).toEqual(['deploy', 'lint', 'review']);
    expect(skills.find((s) => s.name === 'deploy')?.description).toBe('Deploys the app');
  });

  it('falls back to the directory name + first body line without front matter', () => {
    const p = writeSkill('skills', 'migrate', '# Migrate the DB\n\nRun the migration.');
    const skill = parseSkillFile(p);
    expect(skill?.name).toBe('migrate');
    expect(skill?.description).toBe('Migrate the DB');
  });

  it('readSkillBody strips the front matter', () => {
    const p = writeSkill('skills', 'deploy', '---\nname: deploy\n---\nStep 1.\nStep 2.');
    expect(readSkillBody(p)).toBe('Step 1.\nStep 2.');
  });

  it('project roots win over global roots on a name clash', () => {
    const proj = mkdtempSync(join(tmpdir(), 'exc-proj-'));
    const glob = mkdtempSync(join(tmpdir(), 'exc-glob-'));
    try {
      mkdirSync(join(proj, 'skills', 'x'), { recursive: true });
      writeFileSync(
        join(proj, 'skills', 'x', 'SKILL.md'),
        '---\nname: x\ndescription: project\n---\nP',
      );
      mkdirSync(join(glob, 'skills', 'x'), { recursive: true });
      writeFileSync(
        join(glob, 'skills', 'x', 'SKILL.md'),
        '---\nname: x\ndescription: global\n---\nG',
      );
      const skills = loadSkillIndex([proj, glob]);
      expect(skills).toHaveLength(1);
      expect(skills[0]?.description).toBe('project');
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(glob, { recursive: true, force: true });
    }
  });

  it('returns an empty index when there are no skills', () => {
    expect(loadSkillIndex([root])).toEqual([]);
  });
});
