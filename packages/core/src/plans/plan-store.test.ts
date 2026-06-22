import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import { listPlans, plansDir, readPlan, savePlan, slugify } from './plan-store';

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

describe('listPlans / readPlan (D3 reader)', () => {
  it('round-trips saved plans, newest first, parsing the frontmatter', () => {
    const repo = makeTempDir();
    try {
      savePlan(repo, {
        task: 'First "quoted" task',
        planMarkdown: '1. alpha',
        status: 'approved',
        planRunId: 'run_p1',
        now: new Date('2026-06-17T09:00:00.000Z'),
      });
      savePlan(repo, {
        task: 'Second task',
        planMarkdown: '1. beta\n2. gamma',
        status: 'executed',
        planRunId: 'run_p2',
        execRunId: 'run_e2',
        now: new Date('2026-06-18T09:00:00.000Z'),
      });

      const plans = listPlans(repo);
      expect(plans).toHaveLength(2);
      // Newest first (2026-06-18 before 2026-06-17).
      expect(plans[0]?.task).toBe('Second task');
      expect(plans[0]?.status).toBe('executed');
      expect(plans[0]?.planRun).toBe('run_p2');
      expect(plans[0]?.execRun).toBe('run_e2');
      // Quotes in the task are unescaped on read.
      expect(plans[1]?.task).toBe('First "quoted" task');
      expect(plans[1]?.execRun).toBeNull();

      // readPlan by id returns the body too.
      const one = readPlan(repo, plans[0]!.id);
      expect(one?.body).toContain('2. gamma');
      expect(one?.created).toBe('2026-06-18T09:00:00.000Z');
    } finally {
      removeDir(repo);
    }
  });

  it('returns [] when there is no plans folder and null for unknown / unsafe ids', () => {
    const repo = makeTempDir();
    try {
      expect(listPlans(repo)).toEqual([]);
      expect(readPlan(repo, 'nope')).toBeNull();
      // Path-traversal ids are refused.
      expect(readPlan(repo, '../../etc/passwd')).toBeNull();
      expect(readPlan(repo, 'a/b')).toBeNull();
    } finally {
      removeDir(repo);
    }
  });
});
