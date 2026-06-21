import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

/** P1.7 — `excalibur agents list|show|init` for self-contained custom agents. */

function writeAgent(repo: string, name: string, content: string): void {
  const dir = join(repo, '.excalibur', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf8');
}

describe('excalibur agents', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempRepo();
  });
  afterEach(() => removeDir(repo));

  it('lists project custom agents', async () => {
    writeAgent(
      repo,
      'sec',
      '---\nname: Security Reviewer\ndescription: read-only audit\nrole: security\n---\nHunt for bugs.',
    );
    const cli = createTestCli({ cwd: repo });
    await cli.run('agents', 'list');
    const out = cli.stdout();
    expect(out).toMatch(/sec/);
    expect(out).toMatch(/security/);
    expect(out).toMatch(/read-only audit/);
  });

  it('reports an empty catalog with a hint', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('agents', 'list');
    expect(cli.stdout()).toMatch(/no custom agents/i);
  });

  it('shows one agent in full (persona + config) as JSON for `list --json`', async () => {
    writeAgent(repo, 'plan', '---\nrole: planner\nmodel: kimi-k2.7-code\n---\nPlan carefully.');
    const cli = createTestCli({ cwd: repo });
    await cli.run('agents', 'list', '--json');
    const parsed = JSON.parse(cli.stdout()) as Array<{ name: string; role: string; model: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('plan');
    expect(parsed[0]?.role).toBe('planner');
    expect(parsed[0]?.model).toBe('kimi-k2.7-code');
  });

  it('show prints the system prompt', async () => {
    writeAgent(repo, 'merlin', 'You are Merlin, the refactoring sage.');
    const cli = createTestCli({ cwd: repo });
    await cli.run('agents', 'show', 'merlin');
    expect(cli.stdout()).toMatch(/Merlin, the refactoring sage/);
  });

  it('show errors on an unknown agent', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('agents', 'show', 'ghost')).rejects.toThrow(/unknown agent/i);
  });

  it('init scaffolds a starter agent file', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('agents', 'init', 'reviewer');
    const file = join(repo, '.excalibur', 'agents', 'reviewer.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/^---/);
    // It is immediately loadable.
    await cli.run('agents', 'list');
    expect(cli.stdout()).toMatch(/reviewer/);
  });

  it('init refuses to overwrite an existing agent', async () => {
    writeAgent(repo, 'dup', 'Existing.');
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('agents', 'init', 'dup')).rejects.toThrow(/already exists/i);
  });
});
