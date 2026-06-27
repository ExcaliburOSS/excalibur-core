import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTempDir, removeDir } from '../test-utils';
import {
  listPlans,
  planSidecarPath,
  plansDir,
  readPlan,
  resumablePlans,
  savePlan,
  setPlanStatus,
  slugify,
  updatePlanStep,
  writePlanSidecar,
} from './plan-store';

/** The plan id (filename without `.md`) from a saved plan's absolute path. */
function idOf(repo: string, file: string): string {
  return file.slice(plansDir(repo).length + 1, -'.md'.length);
}

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
      // The human .md plus its structured sidecar.
      expect(readdirSync(plansDir(repo)).filter((f) => f.endsWith('.md'))).toHaveLength(1);
      expect(readdirSync(plansDir(repo)).some((f) => f.endsWith('.plan.json'))).toBe(true);

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

describe('structured plan model (PLAN1)', () => {
  it('writes a <id>.plan.json sidecar and readPlan exposes the structure', () => {
    const repo = makeTempDir();
    try {
      const file = savePlan(repo, {
        task: 'Build the thing',
        planMarkdown: '## Setup\n1. Install\n2. Configure\n\n## Build\n- Compile',
        status: 'approved',
        planRunId: 'run_p',
        now: new Date('2026-06-20T09:00:00.000Z'),
      });
      const id = idOf(repo, file);
      expect(existsSync(planSidecarPath(repo, id))).toBe(true);
      const stored = readPlan(repo, id);
      expect(stored?.plan.phases.map((p) => p.title)).toEqual(['Setup', 'Build']);
      expect(stored?.plan.phases[0]?.steps.map((s) => s.title)).toEqual(['Install', 'Configure']);
    } finally {
      removeDir(repo);
    }
  });

  it('renders the .md body FROM an explicitly provided structured plan', () => {
    const repo = makeTempDir();
    try {
      const file = savePlan(repo, {
        task: 'Structured authoring',
        planMarkdown: 'ignored when a structured plan is provided',
        plan: {
          version: 1,
          phases: [
            {
              id: 'p1',
              title: 'Plan',
              steps: [{ id: 'p1.s1', title: 'Step one', status: 'pending' }],
            },
          ],
        },
        status: 'approved',
        planRunId: 'run_p',
        now: new Date('2026-06-20T10:00:00.000Z'),
      });
      const md = readFileSync(file, 'utf8');
      expect(md).toContain('- [ ] Step one');
      expect(md).not.toContain('ignored when a structured plan is provided');
    } finally {
      removeDir(repo);
    }
  });

  it('back-compat: derives the structure from a plan .md that has no sidecar', () => {
    const repo = makeTempDir();
    try {
      const file = savePlan(repo, {
        task: 'Old plan',
        planMarkdown: '1. legacy step',
        status: 'executed',
        planRunId: 'run_p',
        now: new Date('2026-06-20T11:00:00.000Z'),
      });
      const id = idOf(repo, file);
      // Simulate a plan written before the structured model: drop the sidecar.
      rmSync(planSidecarPath(repo, id));
      const stored = readPlan(repo, id);
      expect(existsSync(planSidecarPath(repo, id))).toBe(false);
      expect(stored?.plan.phases[0]?.steps[0]?.title).toBe('legacy step');
    } finally {
      removeDir(repo);
    }
  });

  it('updatePlanStep flips a step status + run id, persists, and is read back', () => {
    const repo = makeTempDir();
    try {
      const file = savePlan(repo, {
        task: 'Track me',
        planMarkdown: '1. first\n2. second',
        status: 'approved',
        planRunId: 'run_p',
        now: new Date('2026-06-20T12:00:00.000Z'),
      });
      const id = idOf(repo, file);
      expect(updatePlanStep(repo, id, 'p1.s1', 'done', 'run_exec_1')).toBe(true);
      const step = readPlan(repo, id)?.plan.phases[0]?.steps.find((s) => s.id === 'p1.s1');
      expect(step?.status).toBe('done');
      expect(step?.runId).toBe('run_exec_1');
      // Unknown step / unknown plan → false.
      expect(updatePlanStep(repo, id, 'nope', 'done')).toBe(false);
      expect(updatePlanStep(repo, 'missing-plan', 'p1.s1', 'done')).toBe(false);
    } finally {
      removeDir(repo);
    }
  });
});

describe('setPlanStatus / resumablePlans (PLAN3)', () => {
  it('rewrites just the frontmatter status line and is read back', () => {
    const repo = makeTempDir();
    try {
      const file = savePlan(repo, {
        task: 'Flip me',
        planMarkdown: '1. one\n2. two',
        status: 'approved',
        planRunId: 'run_p',
        now: new Date('2026-06-27T09:00:00.000Z'),
      });
      const id = idOf(repo, file);
      expect(readPlan(repo, id)?.status).toBe('approved');
      expect(setPlanStatus(repo, id, 'executed')).toBe(true);
      expect(readPlan(repo, id)?.status).toBe('executed');
      // The body is untouched.
      expect(readPlan(repo, id)?.body).toContain('two');
      // Unknown / unsafe ids → false.
      expect(setPlanStatus(repo, 'missing-plan', 'executed')).toBe(false);
      expect(setPlanStatus(repo, '../escape', 'executed')).toBe(false);
    } finally {
      removeDir(repo);
    }
  });

  it('lists approved plans with a still-pending step, newest first', () => {
    const repo = makeTempDir();
    try {
      // Approved + unfinished → resumable.
      const live = savePlan(repo, {
        task: 'Resume me',
        planMarkdown: '1. alpha\n2. beta',
        status: 'approved',
        planRunId: 'run_a',
        now: new Date('2026-06-27T09:00:00.000Z'),
      });
      const liveId = idOf(repo, live);
      // Approved but fully done → NOT resumable.
      const finished = savePlan(repo, {
        task: 'All done',
        planMarkdown: '1. only',
        status: 'approved',
        planRunId: 'run_b',
        now: new Date('2026-06-27T08:00:00.000Z'),
      });
      const finishedId = idOf(repo, finished);
      updatePlanStep(repo, finishedId, 'p1.s1', 'done');
      // Executed → never resumable regardless of steps.
      savePlan(repo, {
        task: 'Already executed',
        planMarkdown: '1. x',
        status: 'executed',
        planRunId: 'run_c',
        execRunId: 'run_e',
        now: new Date('2026-06-27T10:00:00.000Z'),
      });

      const resumable = resumablePlans(repo);
      expect(resumable.map((p) => p.id)).toEqual([liveId]);
      expect(resumable[0]?.task).toBe('Resume me');

      // Once its last step is done, it drops off the resumable list.
      updatePlanStep(repo, liveId, 'p1.s1', 'done');
      updatePlanStep(repo, liveId, 'p1.s2', 'done');
      expect(resumablePlans(repo)).toEqual([]);
    } finally {
      removeDir(repo);
    }
  });

  it('writePlanSidecar overwrites the sidecar (workItemId/epic links survive)', () => {
    const repo = makeTempDir();
    try {
      const file = savePlan(repo, {
        task: 'Materialize me',
        planMarkdown: '1. first\n2. second',
        status: 'approved',
        planRunId: 'run_p',
        now: new Date('2026-06-27T12:00:00.000Z'),
      });
      const id = idOf(repo, file);
      const stored = readPlan(repo, id)!;
      // Stamp PLAN2 links onto the in-memory plan and persist them.
      stored.plan.epicWorkItemId = 'WI-1';
      stored.plan.phases[0]!.steps[0]!.workItemId = 'WI-2';
      expect(writePlanSidecar(repo, id, stored.plan)).toBe(true);

      const back = readPlan(repo, id);
      expect(back?.plan.epicWorkItemId).toBe('WI-1');
      expect(back?.plan.phases[0]?.steps[0]?.workItemId).toBe('WI-2');
      // Unsafe / unknown ids → false.
      expect(writePlanSidecar(repo, '../escape', stored.plan)).toBe(false);
      expect(writePlanSidecar(repo, 'missing-plan', stored.plan)).toBe(false);
    } finally {
      removeDir(repo);
    }
  });
});
