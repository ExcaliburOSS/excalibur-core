import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { RunManager, SessionStore } from '@excalibur/core';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

/** P1.12: the `stats` command + `session export|import`. */

describe('excalibur stats', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempRepo();
  });
  afterEach(() => removeDir(repo));

  it('reports "no runs" on an empty repo', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('stats');
    expect(cli.stdout()).toMatch(/no runs/i);
  });

  it('aggregates run history (totals + JSON)', async () => {
    const rm = new RunManager(repo);
    const run = rm.createRun({ title: 'T', autonomyLevel: 3, workflow: 'fast-fix' });
    rm.updateRecord(run.id, { status: 'completed' });
    rm.appendModelCall(run.id, {
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      inputTokens: 100,
      outputTokens: 40,
      costCents: 5,
      timestamp: new Date().toISOString(),
    });
    const cli = createTestCli({ cwd: repo });
    await cli.run('stats', '--json');
    const insights = JSON.parse(cli.stdout()) as { totalRuns: number; totalCostCents: number };
    expect(insights.totalRuns).toBe(1);
    expect(insights.totalCostCents).toBe(5);
  });
});

describe('excalibur session export/import', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempRepo();
  });
  afterEach(() => removeDir(repo));

  it('exports a session as JSON and re-imports it', async () => {
    const store = new SessionStore(repo);
    const s = store.createSession({ title: 'Debug auth' });
    store.appendTurn(s.id, { role: 'user', kind: 'message', text: 'why does login fail?' });
    store.appendTurn(s.id, { role: 'assistant', kind: 'message', text: 'the token is expired' });

    const exportCli = createTestCli({ cwd: repo });
    await exportCli.run('session', 'export', s.id, '--format', 'json');
    const exported = JSON.parse(exportCli.stdout()) as {
      metadata: { title: string };
      turns: unknown[];
    };
    expect(exported.metadata.title).toBe('Debug auth');
    expect(exported.turns).toHaveLength(2);

    // Write the export to a file and import it into a fresh session.
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const file = join(repo, 'export.json');
    writeFileSync(file, JSON.stringify(exported), 'utf8');

    const importCli = createTestCli({ cwd: repo });
    await importCli.run('session', 'import', file);
    expect(importCli.stdout()).toMatch(/imported 2 turn/i);

    // The imported session has the two turns.
    const sessions = store.listSessions();
    expect(sessions.length).toBe(2);
    const newest = sessions[sessions.length - 1];
    expect(store.readTranscript(newest!.id).map((t) => t.text)).toEqual([
      'why does login fail?',
      'the token is expired',
    ]);
  });

  it('exports as Markdown', async () => {
    const store = new SessionStore(repo);
    const s = store.createSession({ title: 'Notes' });
    store.appendTurn(s.id, { role: 'user', kind: 'message', text: 'hello there' });
    const cli = createTestCli({ cwd: repo });
    await cli.run('session', 'export', s.id, '--format', 'md');
    expect(cli.stdout()).toMatch(/# Session: Notes/);
    expect(cli.stdout()).toMatch(/hello there/);
  });
});
