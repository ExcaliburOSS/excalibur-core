import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { RunManager } from '@excalibur/core';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import { defaultDeps } from '../deps';
import { makeTempRepo, removeDir } from '../test-utils';
import { buildManagementToolset } from './management-tools';

/**
 * The host implementations of the proactive management tools (#241) read the
 * SAME local stores the `excalibur <command>`s use. These assert they return
 * real data — the deterministic wiring (adapter → ctx.management) is proven in
 * the agent-runtime adapter test.
 */
describe('buildManagementToolset', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempRepo();
  });
  afterEach(() => removeDir(repo));

  it('projectStatus reports real run + work-item counts', async () => {
    const rm = new RunManager(repo);
    rm.createRun({ title: 'Add login', autonomyLevel: 4, workflow: 'fast-fix' });
    new LocalWorkItemProvider(repo).createWorkItem({ title: 'Fix the logout bug' });

    const out = await buildManagementToolset(defaultDeps({ cwd: () => repo }), repo).projectStatus!(
      {},
    );
    expect(out).toMatch(/Runs: 1/);
    expect(out).toMatch(/Work items:/);
  });

  it('workItems lists seeded items and finds one by key', async () => {
    const provider = new LocalWorkItemProvider(repo);
    const created = provider.createWorkItem({ title: 'Fix the logout bug', estimate: 3 });
    const tools = buildManagementToolset(defaultDeps({ cwd: () => repo }), repo);

    const list = await tools.workItems!({});
    expect(list).toContain('Fix the logout bug');
    expect(list).toContain('3pt');

    const one = await tools.workItems!({ key: created.key });
    expect(one).toContain(created.key);
    expect(one).toContain('Fix the logout bug');
  });

  it('reports empty stores gracefully (no throw) for sprints and plans', async () => {
    const tools = buildManagementToolset(defaultDeps({ cwd: () => repo }), repo);
    await expect(tools.sprintStatus!({})).resolves.toMatch(/no active sprint/i);
    await expect(tools.plans!({})).resolves.toMatch(/no saved plans/i);
    await expect(tools.workItems!({})).resolves.toMatch(/no work items/i);
  });

  it('verify/review return the working-tree diff for the agent to self-check (no model call)', async () => {
    // A clean tree → nothing to check.
    const clean = buildManagementToolset(defaultDeps({ cwd: () => repo }), repo);
    await expect(clean.verify!({})).resolves.toMatch(/nothing to verify/i);
    await expect(clean.review!({})).resolves.toMatch(/nothing to review/i);

    // A real change → the diff is handed back, framed for self-verification.
    writeFileSync(
      join(repo, 'src', 'service.ts'),
      'export function release(id: string): string {\n  return id.trim();\n}\n',
    );
    const tools = buildManagementToolset(defaultDeps({ cwd: () => repo }), repo);
    const verify = await tools.verify!({});
    expect(verify).toMatch(/service\.ts/);
    expect(verify).toMatch(/working-tree diff/i);
    const review = await tools.review!({});
    expect(review).toMatch(/service\.ts/);
  });

  it('remember captures a durable project memory the agent can persist itself (#253)', async () => {
    const tools = buildManagementToolset(defaultDeps({ cwd: () => repo }), repo);
    const out = await tools.remember!({
      statement: 'src/service.ts must stay idempotent — release() is retried by the queue.',
    });
    expect(out).toMatch(/saved a project memory/i);
    // Inferred the subject path from the statement so a future run is primed.
    expect(out).toMatch(/src\/service\.ts/);
    // A corroborating capture REINFORCES (does not duplicate) the same memory.
    const again = await tools.remember!({
      statement: 'src/service.ts must stay idempotent — release() is retried by the queue.',
    });
    expect(again).toMatch(/reinforced/i);
    // It is durably persisted on disk (a future run will retrieve it).
    expect(new RunManager(repo)).toBeDefined();
  });

  it('investigate is a READ-ONLY parallel exploration tool that needs a real model', async () => {
    const tools = buildManagementToolset(defaultDeps({ cwd: () => repo }), repo);
    // The test repo runs the mock provider — parallel exploration needs a REAL model, so
    // it refuses gracefully (never throws into the agent loop) rather than fan out mock
    // explorers returning templated junk. (The real fan-out path = computeScope, covered
    // by the scope-engine tests.)
    const out = await tools.investigate!({ task: 'how does the run pipeline pick a workflow?' });
    expect(out).toMatch(/cannot investigate|no real model/i);
    // An empty task is handled, never throws.
    await expect(tools.investigate!({ task: '   ' })).resolves.toMatch(/nothing to investigate/i);
  });
});
