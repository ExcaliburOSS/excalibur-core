import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import { plansDir, savePlan, slugify } from './plan-store';

describe('slugify', () => {
  it('produces a filesystem-safe, capped slug', () => {
    expect(slugify('Add multiply() to src/math.ts!')).toBe('add-multiply-to-src-math-ts');
    expect(slugify('   ')).toBe('plan'); // never empty
    expect(slugify('A'.repeat(80)).length).toBeLessThanOrEqual(50);
  });
});

describe('savePlan', () => {
  it('writes a frontmatter+markdown plan into .excalibur/plans and returns its path', () => {
    const repo = makeTempDir();
    try {
      const file = savePlan(repo, {
        task: 'Refactor the auth module',
        planMarkdown: '1. Read models\n2. Extract guard\n3. Add tests',
        status: 'executed',
        planRunId: 'run_plan_1',
        execRunId: 'run_exec_1',
        now: new Date('2026-06-17T09:30:05.000Z'),
      });
      expect(file.startsWith(plansDir(repo))).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(readdirSync(plansDir(repo))).toHaveLength(1);

      const md = readFileSync(file, 'utf8');
      // Frontmatter carries the queryable metadata.
      expect(md).toMatch(/^---\n/);
      expect(md).toContain('task: "Refactor the auth module"');
      expect(md).toContain('status: executed');
      expect(md).toContain('planRun: run_plan_1');
      expect(md).toContain('execRun: run_exec_1');
      expect(md).toContain('created: 2026-06-17T09:30:05.000Z');
      // Body carries the title + the plan markdown.
      expect(md).toContain('# Plan: Refactor the auth module');
      expect(md).toContain('2. Extract guard');
      // The filename is a sortable stamp + slug.
      expect(file).toMatch(/\/\d{8}-\d{6}-refactor-the-auth-module\.md$/);
    } finally {
      removeDir(repo);
    }
  });

  it('omits execRun from the frontmatter when not yet executed', () => {
    const repo = makeTempDir();
    try {
      const file = savePlan(repo, {
        task: 'Plan only',
        planMarkdown: 'do x',
        status: 'approved',
        planRunId: 'run_p',
        now: new Date('2026-06-17T10:00:00.000Z'),
      });
      const md = readFileSync(file, 'utf8');
      expect(md).toContain('status: approved');
      expect(md).not.toContain('execRun:');
    } finally {
      removeDir(repo);
    }
  });
});
