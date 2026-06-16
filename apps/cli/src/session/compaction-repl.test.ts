import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runInteractiveSession } from './repl';
import { createInteractiveCli, makeTempRepo, removeDir } from '../test-utils';

/**
 * `/compact` in the M-Shell (offline, mock provider). A tiny `keepRecentTokens`
 * makes a manual /compact have older turns to fold into a summary; the record is
 * persisted to `.excalibur/sessions/<id>/compactions.jsonl`.
 */

const repos: string[] = [];
afterAll(() => repos.forEach(removeDir));

function compactionRecords(repo: string): unknown[] {
  const base = join(repo, '.excalibur', 'sessions');
  if (!existsSync(base)) return [];
  const id = readdirSync(base).find((d) => existsSync(join(base, d, 'compactions.jsonl')));
  if (id === undefined) return [];
  return readFileSync(join(base, id, 'compactions.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('/compact in a session', () => {
  it('condenses older turns, persists a record, and reports before→after', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    // keepRecentTokens 1 → a manual /compact folds everything but the last turn.
    mkdirSync(join(repo, '.excalibur'), { recursive: true });
    writeFileSync(
      join(repo, '.excalibur', 'config.yaml'),
      'compaction:\n  keepRecentTokens: 1\n',
      'utf8',
    );

    const cli = createInteractiveCli({ cwd: repo });
    cli.send('first message');
    cli.send('second message');
    cli.send('/compact');
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});

    const out = cli.stdout();
    expect(out).toContain('Compacted');
    expect(out).toContain('summary');
    expect(compactionRecords(repo).length).toBeGreaterThanOrEqual(1);
  });

  it('reports nothing-to-compact on a fresh session (default budget)', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const cli = createInteractiveCli({ cwd: repo });
    cli.send('/compact');
    cli.send('/exit');
    await runInteractiveSession(cli.deps, {});
    expect(cli.stdout()).toContain('Nothing to compact');
  });
});
