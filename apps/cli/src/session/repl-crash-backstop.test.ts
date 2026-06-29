import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '@excalibur/core';
import { createInteractiveCli } from '../test-utils';
import { runInteractiveSession } from './repl';

/**
 * RUN-FIX-22 — the per-turn BACKSTOP: the m-shell can NEVER exit on an execution error.
 *
 * The historical 100%-reproducible crash: the turn body BETWEEN the prompt read and the
 * per-turn try/catch (the cross-turn seed, the sync disk writes, the intent classifier,
 * the route-accept confirms, getGitInfo) ran UNGUARDED. An exception there — e.g. a sync
 * disk write throwing (ENOSPC/EACCES after a build wrote many files), or any awaited
 * rejection — was NOT delivered as an `unhandledRejection`, so the process-level net never
 * saw it; it unwound the for(;;) loop into the disarming `finally` and the process exited.
 *
 * This reproduces it deterministically: `SessionStore.appendPromptHistory` (called once
 * per turn, inside that region) is forced to throw on the FIRST turn. WITHOUT the backstop
 * the fault propagates out of runInteractiveSession and this test's await REJECTS (proven
 * by neutering the backstop → this test fails). WITH it, the fault is caught, the prompt
 * returns, and the session survives to `/exit` → resolves cleanly.
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'exc-backstop-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  const models = join(repo, '.excalibur', 'models');
  mkdirSync(models, { recursive: true });
  writeFileSync(
    join(models, 'providers.yaml'),
    'providers:\n  default: mock\n  mock:\n    type: mock\n',
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe('RUN-FIX-22 — per-turn backstop (the shell never exits on an execution fault)', () => {
  it('survives an un-guarded between-turn fault (disk write throw) and returns cleanly at /exit', async () => {
    // Inject a fault into the FIRST turn's between-prompt region — exactly where the crash
    // used to escape. appendPromptHistory is called once per submitted line at repl.ts,
    // BEFORE the per-turn try opened, so a throw here is the canonical un-guarded fault.
    const spy = vi
      .spyOn(SessionStore.prototype, 'appendPromptHistory')
      .mockImplementationOnce(() => {
        throw new Error('injected disk fault (ENOSPC) during the turn body');
      });

    const cli = createInteractiveCli({ cwd: repo, env: { PATH: process.env.PATH ?? '' } });
    cli.send('please add a small helper function to the project');
    cli.send('/exit');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      // The crux: MUST resolve (survived the fault + reached /exit), never reject.
      const code = await runInteractiveSession(cli.deps, {});
      expect(code).toBe(0);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalled(); // the fault really fired in the turn body
    } finally {
      exitSpy.mockRestore();
    }
  }, 20000);
});
