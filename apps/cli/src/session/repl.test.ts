import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runInteractiveSession } from './repl';
import { createInteractiveCli, makeTempRepo, removeDir } from '../test-utils';

/**
 * Offline REPL tests (M-Shell Slice A). Each uses the mock provider (no
 * providers.yaml in the temp repo), an `interactive: true` Ui bound to scripted
 * stdin + memory stdout (so streaming runs), and asserts on captured stdout and
 * the persisted `.excalibur/sessions/<id>/transcript.jsonl`.
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

describe('interactive session (M-Shell Slice A)', () => {
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
    expect(stdout).toContain('EXCALIBUR');
    expect(stdout).toContain('Welcome back');
    expect(stdout).toContain('Describe what you want');
    // /help capabilities + lanes.
    expect(stdout).toContain('show this help');
    expect(stdout).toContain('discovery');
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

  it('routes a question to the ask lane (streamed mock turn + interaction artifact + transcript)', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('How does the run pipeline select a workflow?');
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});

    const stdout = cli.stdout();
    expect(stdout).toContain('→ ask · ask-repo · L1');

    // An InteractionStore artifact was created (ask dispatch).
    const interactions = join(repo, '.excalibur', 'interactions');
    expect(existsSync(interactions)).toBe(true);
    expect(readdirSync(interactions).length).toBeGreaterThanOrEqual(1);

    // The transcript recorded a user turn, a route turn and an assistant turn.
    const dirs = sessionDirs();
    const turns = readTranscript(dirs[dirs.length - 1] as string);
    expect(turns.some((t) => t.role === 'user' && t.kind === 'message')).toBe(true);
    expect(turns.some((t) => t.kind === 'route' && String(t.route).startsWith('ask:'))).toBe(true);
    const assistant = turns.find((t) => t.role === 'assistant' && t.kind === 'message');
    expect(assistant).toBeDefined();
    expect(assistant?.model).toBe('mock');
    expect(assistant?.artifactRef).toMatch(/^int_/);
  });

  it('routes an actionable task to the run lane (approve → runs/<id> completed)', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('Fix the typo in README.md');
    // The run pipeline reads `[Enter] continue` then approval gates; empty
    // lines accept the safe defaults (continue / approve). Extra empties after
    // the dispatch are harmless no-op turns (they only reprint the StatusLine).
    for (let i = 0; i < 12; i += 1) {
      cli.send('');
    }
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});

    const stdout = cli.stdout();
    expect(stdout).toContain('→ run');
    expect(stdout).toContain('run completed');

    const runsDir = join(repo, '.excalibur', 'runs');
    expect(existsSync(runsDir)).toBe(true);
    const runs = readdirSync(runsDir).filter((name) => name.startsWith('run_'));
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const dirs = sessionDirs();
    const turns = readTranscript(dirs[dirs.length - 1] as string);
    const assistant = turns.find((t) => t.role === 'assistant' && t.kind === 'message');
    expect(assistant?.artifactRef).toMatch(/^run_/);
  });

  it('routes an ambiguous idea to the discovery lane (discovery session created)', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('the whole onboarding experience');
    // Discovery asks its question pack interactively (yes: false); empty lines
    // skip each question. Extra empties after the session are no-op turns.
    for (let i = 0; i < 12; i += 1) {
      cli.send('');
    }
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});

    const stdout = cli.stdout();
    expect(stdout).toContain('→ discovery');
    // The discovery readiness card is printed.
    expect(stdout).toContain('Recommendation:');

    const discoveryDir = join(repo, '.excalibur', 'discovery');
    expect(existsSync(discoveryDir)).toBe(true);
    expect(readdirSync(discoveryDir).filter((name) => name.startsWith('disc_')).length).toBeGreaterThanOrEqual(1);
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
    // First session: one ask turn, then exit.
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

  it('a recognised !shell passthrough is deferred (no execution)', async () => {
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('!ls -la');
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});
    expect(cli.stdout()).toContain('later slice');
  });
});
