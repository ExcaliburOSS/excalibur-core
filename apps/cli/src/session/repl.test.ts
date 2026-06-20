import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RunManager } from '@excalibur/core';
import { runInteractiveSession } from './repl';
import { createInteractiveCli, makeTempRepo, removeDir } from '../test-utils';

/**
 * Offline REPL tests (M-Shell, model-first). Each uses the mock provider (no
 * providers.yaml in the temp repo), an `interactive: true` Ui bound to scripted
 * stdin + memory stdout (so the agent loop and inline prompts actually run), and
 * asserts on captured stdout and the persisted
 * `.excalibur/sessions/<id>/transcript.jsonl`.
 *
 * The shell is MODEL-FIRST: a natural-language line drives the real agentic
 * loop. With the mock provider the loop requests no tools and returns a
 * templated text answer (graceful offline demo) — so these tests assert on that
 * answer and the run artifacts the turn produces. The fake-gateway agentic path
 * (a scripted tool call + inline approval + plan-mode) is covered separately in
 * agent-turn.test.ts.
 */

const repo = makeTempRepo();

afterAll(() => removeDir(repo));

function sessionDirs(): string[] {
  const base = join(repo, '.excalibur', 'sessions');
  return existsSync(base)
    ? readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
}

function readTranscript(id: string): Array<Record<string, unknown>> {
  const file = join(repo, '.excalibur', 'sessions', id, 'transcript.jsonl');
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('interactive session (M-Shell, model-first)', () => {
  it('redacts secrets from the persisted transcript and prompt history', async () => {
    // Built at runtime so the literal never appears in this source file.
    const key = `sk-${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
    const before = new Set(sessionDirs());
    const cli = createInteractiveCli({ cwd: repo });
    cli.send(`why is the key ${key} rejected?`);
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});

    const id = sessionDirs().find((dir) => !before.has(dir));
    expect(id).toBeDefined();
    const transcript = readTranscript(id as string);
    const userTurn = transcript.find((turn) => turn['role'] === 'user');
    expect(String(userTurn?.['text'])).toContain('[REDACTED]');
    expect(JSON.stringify(transcript)).not.toContain(key);

    const history = readFileSync(join(repo, '.excalibur', 'sessions', 'history'), 'utf8');
    expect(history).toContain('[REDACTED]');
    expect(history).not.toContain(key);
  });

  it('prints the welcome banner + status line, runs /help, then /exit', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('/help');
    cli.send('/exit');
    const code = await runInteractiveSession(cli.deps, {});

    expect(code).toBe(0);
    const stdout = cli.stdout();
    // Welcome banner (two-column frame): title + greeting + a tip.
    expect(stdout).toContain('Excalibur');
    expect(stdout).toContain('Welcome back');
    expect(stdout).toContain('Describe what you want');
    // /help capabilities + the model-first explainer.
    expect(stdout).toContain('show this help');
    expect(stdout).toContain('/plan');
    expect(stdout).toContain('/swarm');
    expect(stdout).toContain('the model decides');
    // StatusLine: model mock + cost + safety preset.
    expect(stdout).toContain('mock');
    expect(stdout).toContain('$0.00');
    expect(stdout).toContain('standard-safe');
    // Graceful close farewell.
    expect(stdout).toContain('closed');
    expect(stdout).toContain('Goodbye.');

    const dirs = sessionDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(1);
  });

  it('a natural-language line drives the agent loop (mock = text answer + a run artifact)', async () => {
    const before = new Set(sessionDirs());
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('How does the run pipeline select a workflow?');
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});

    const stdout = cli.stdout();
    // The model-driven turn renders the agent loop (a run dir, a model call, a
    // completion) — not a keyword lane label.
    expect(stdout).toContain('→ agent');
    expect(stdout).toContain('run completed');
    // The mock degraded answer is its templated banner.
    expect(stdout).toContain('Mock provider (M1)');

    // A real RunManager run was created (events.jsonl → replay/time-machine).
    const runsDir = join(repo, '.excalibur', 'runs');
    expect(existsSync(runsDir)).toBe(true);
    const runs = readdirSync(runsDir).filter((name) => name.startsWith('run_'));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const latestRun = runs.sort()[runs.length - 1] as string;
    expect(existsSync(join(runsDir, latestRun, 'events.jsonl'))).toBe(true);

    // The transcript recorded a user turn and an assistant turn referencing the run.
    const id = sessionDirs().find((dir) => !before.has(dir)) as string;
    const turns = readTranscript(id);
    expect(turns.some((t) => t.role === 'user' && t.kind === 'message')).toBe(true);
    const assistant = turns.find((t) => t.role === 'assistant' && t.kind === 'message');
    expect(assistant).toBeDefined();
    expect(assistant?.model).toBe('mock');
    expect(assistant?.artifactRef).toMatch(/^run_/);
  });

  it('an empty line reprints the StatusLine', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('');
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});
    // Two status lines at least: the initial one and the reprint after empty.
    const matches = cli.stdout().match(/standard-safe/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('--continue replays the prior transcript and reuses the session id', async () => {
    // First session: one turn, then exit.
    const first = createInteractiveCli({ cwd: repo });
    first.send('What does the session store persist?');
    first.send('/exit');
    await runInteractiveSession(first.deps, {});
    const idAfterFirst = sessionDirs()[sessionDirs().length - 1] as string;

    // Second session with --continue: must reuse the same id and replay.
    const second = createInteractiveCli({ cwd: repo });
    second.send('/exit');
    await runInteractiveSession(second.deps, { continue: true });

    expect(second.stdout()).toContain(`Resuming session ${idAfterFirst}`);
    // No NEW session directory was created for the --continue run.
    const idAfterSecond = sessionDirs()[sessionDirs().length - 1] as string;
    expect(idAfterSecond).toBe(idAfterFirst);
    // The continued session is closed again after exit.
    const metadata = JSON.parse(
      readFileSync(join(repo, '.excalibur', 'sessions', idAfterFirst, 'metadata.json'), 'utf8'),
    ) as { status: string };
    expect(metadata.status).toBe('closed');
  });

  it('graceful EOF (Ctrl-D) closes the session with status closed and exit 0', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    // No /exit — end stdin to simulate Ctrl-D.
    cli.end();
    const code = await runInteractiveSession(cli.deps, {});
    expect(code).toBe(0);
    expect(cli.stdout()).not.toContain('Error');

    const dirs = sessionDirs();
    const id = dirs[dirs.length - 1] as string;
    const metadata = JSON.parse(
      readFileSync(join(repo, '.excalibur', 'sessions', id, 'metadata.json'), 'utf8'),
    ) as { status: string };
    expect(metadata.status).toBe('closed');
  });

  it('a !shell passthrough runs the command and shows its output', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('!echo hello-from-shell');
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});
    const stdout = cli.stdout();
    expect(stdout).toContain('$ echo hello-from-shell');
    expect(stdout).toContain('hello-from-shell');

    const dirs = sessionDirs();
    const turns = readTranscript(dirs[dirs.length - 1] as string);
    expect(turns.some((t) => t.kind === 'status' && String(t.text).startsWith('shell:'))).toBe(
      true,
    );
  });

  it('/swarm with no task shows usage and never crashes the session', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('/swarm');
    cli.send('/exit');
    const code = await runInteractiveSession(cli.deps, {});
    expect(code).toBe(0);
    // The empty-arg guard returns BEFORE the git/provider checks, so it is safe
    // in a non-git temp repo and prints the usage hint.
    expect(cli.stdout()).toContain('/swarm <task>');
  });

  it('/bg with no task shows usage and never crashes the session', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('/bg');
    cli.send('/exit');
    const code = await runInteractiveSession(cli.deps, {});
    expect(code).toBe(0);
    expect(cli.stdout()).toContain('/bg <task>');
  });

  it('/bg launches a background thread (its own recorded run) and /threads lists it', async () => {
    const bgRepo = makeTempRepo();
    try {
      const before = new RunManager(bgRepo).listRuns().length;
      const cli = createInteractiveCli({ cwd: bgRepo });
      cli.send('/bg add a HELLO constant to src/util.ts');
      cli.send('/threads');
      cli.send('/exit');
      const code = await runInteractiveSession(cli.deps, {});
      expect(code).toBe(0);
      const out = cli.stdout();
      // The thread was announced (/bg) and listed (/threads).
      expect(out).toContain('background');
      expect(out).toContain('add a HELLO constant to src/util.ts');
      // A real run was created synchronously for the background turn.
      expect(new RunManager(bgRepo).listRuns().length).toBeGreaterThan(before);
    } finally {
      // Let any detached background work settle before the dir is removed.
      await new Promise((resolve) => setTimeout(resolve, 30));
      removeDir(bgRepo);
    }
  });

  it('/discovery <idea> runs the explicit clarification flow (discovery session created)', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('/discovery the whole onboarding experience');
    // Discovery asks its question pack interactively; empty lines skip each.
    for (let i = 0; i < 12; i += 1) {
      cli.send('');
    }
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});

    const stdout = cli.stdout();
    expect(stdout).toContain('Recommendation:');
    const discoveryDir = join(repo, '.excalibur', 'discovery');
    expect(existsSync(discoveryDir)).toBe(true);
    expect(
      readdirSync(discoveryDir).filter((name) => name.startsWith('disc_')).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('/fork forks the latest run (reusing its cached context) and records the fork', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('How does the run pipeline work?'); // a NL turn → creates a run
    cli.send('/fork now also add a note'); // fork that run from its last step
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});

    expect(cli.stdout()).toContain('fork of');
    // A run.json carrying fork provenance now exists.
    const runsDir = join(repo, '.excalibur', 'runs');
    const forked = readdirSync(runsDir)
      .filter((id) => id.startsWith('run_'))
      .some((id) => {
        const record = JSON.parse(readFileSync(join(runsDir, id, 'run.json'), 'utf8')) as {
          forkedFrom?: unknown;
        };
        return record.forkedFrom != null;
      });
    expect(forked).toBe(true);
  });

  it('a slash command on a corrupt run errors gracefully — the session survives', async () => {
    // Regression for the unguarded loadReplay crash: a command that resolves a
    // run with an unreadable events.jsonl must NOT kill the whole session.
    const freshRepo = makeTempRepo();
    try {
      const run = new RunManager(freshRepo).createRun({
        title: 'x',
        autonomyLevel: 3,
        workflow: 'conversation',
        methodology: null,
        model: 'mock',
        executionStyle: 'team_default',
      });
      writeFileSync(join(run.dir, 'events.jsonl'), 'this is not valid json\n', 'utf8');

      const cli = createInteractiveCli({ cwd: freshRepo });
      cli.send('/changes'); // resolves the latest (corrupt) run → loadReplay throws
      cli.send('/exit');
      const code = await runInteractiveSession(cli.deps, {});

      expect(code).toBe(0); // the session survived and closed cleanly
      expect(cli.stdout()).toContain('Goodbye.');
    } finally {
      removeDir(freshRepo);
    }
  });
});
