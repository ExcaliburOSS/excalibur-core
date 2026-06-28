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
});
