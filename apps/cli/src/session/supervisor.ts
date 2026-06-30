import { spawn } from 'node:child_process';
import type { InteractiveSessionOptions } from './repl';

/**
 * RUN-FIX-24 — the UNCRASHABLE supervisor.
 *
 * The interactive m-shell must be structurally impossible to lose, even when the running
 * session dies by a means that no in-process guard can survive: an uncatchable `SIGKILL`
 * (e.g. a stray process-GROUP kill while a build starts a server), a native V8/libuv crash,
 * or an OOM. In-process armor (RUN-FIX-14/18/20) handles every CATCHABLE fault; this is the
 * outer ring for the rest.
 *
 * The real session runs in a CHILD process. This thin parent does nothing fragile — no Ink,
 * no model, no tty writes beyond a one-line recovery notice — and simply RESPAWNS the child
 * (resuming the same session with `--continue`) whenever it dies abnormally. From the user's
 * seat the shell never disappears: it blinks and comes back with the conversation intact.
 *
 * The child shares the parent's process group + stdio (so the user's Ctrl-C still reaches the
 * foreground child via the pty, and raw-mode/Ink work normally). The supervisor IGNORES the
 * catchable termination signals so a stray one can't take IT down. A genuine crash kills only
 * the child PID, never the parent — so the parent is always there to bring the shell back.
 */

const SUPERVISED_ENV = 'EXCALIBUR_SUPERVISED';
const DISABLE_ENV = 'EXCALIBUR_NO_SUPERVISOR';

/** True when THIS process is the supervised child (it should run the session directly). */
export function isSupervisedChild(): boolean {
  return process.env[SUPERVISED_ENV] === '1';
}

/**
 * Whether to wrap the interactive session in a supervisor. On by default for a real
 * interactive TTY; opt out with EXCALIBUR_NO_SUPERVISOR=1 (tests, debugging, or a host that
 * forbids a re-exec). Never supervises a non-TTY (piped/CI) run — there is no session to keep.
 */
export function supervisorEnabled(): boolean {
  return (
    process.env[DISABLE_ENV] !== '1' &&
    !isSupervisedChild() &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  );
}

/** Reconstruct the interactive flags so a respawn resumes the SAME session. */
function sessionArgs(opts: InteractiveSessionOptions, forceContinue: boolean): string[] {
  if (forceContinue) {
    return ['--continue'];
  }
  if (opts.resume !== undefined) {
    return ['--resume', opts.resume];
  }
  if (opts.continue === true) {
    return ['--continue'];
  }
  return [];
}

/**
 * Run the interactive session under the supervisor. `runInline` is the in-process fallback
 * used only if spawning the child is impossible (so the user is never left with nothing).
 * `notice(signal, code)` renders the one-line recovery message (i18n lives in the caller).
 */
export function runSupervisor(
  opts: InteractiveSessionOptions,
  runInline: () => void,
  notice: (detail: string) => string,
): void {
  // The supervisor must survive a stray catchable signal: ignore them. The user's Ctrl-C is
  // delivered by the pty to the FOREGROUND process group — the child — not to us, so ignoring
  // SIGINT here does not swallow the user's cancel.
  const ignored: NodeJS.Signals[] = [
    'SIGHUP',
    'SIGINT',
    'SIGTERM',
    'SIGQUIT',
    'SIGTSTP',
    'SIGTTIN',
    'SIGTTOU',
    'SIGPIPE',
    'SIGUSR1',
    'SIGUSR2',
  ];
  for (const sig of ignored) {
    try {
      process.on(sig, () => {});
    } catch {
      /* a platform without this signal — ignore */
    }
  }

  const selfScript = process.argv[1] ?? '';
  // Crash-loop backstop: a child that dies almost immediately, repeatedly, is a startup
  // fault (bad config, a broken build) — respawning forever would spin. Allow a burst, then
  // stop and surface it. A child that lived a while before dying is a legitimate mid-session
  // crash and resets the counter.
  const FAST_DEATH_MS = 4000;
  const MAX_FAST_DEATHS = 6;
  let fastDeaths = 0;

  const launch = (resume: boolean, isRespawn: boolean): void => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [selfScript, ...sessionArgs(opts, resume)], {
        stdio: 'inherit',
        env: {
          ...process.env,
          [SUPERVISED_ENV]: '1',
          // Tell the child it came back from a crash (a chaos/test crash hook fires only on
          // the FIRST child, never in a respawn — so recovery is verifiable without looping).
          ...(isRespawn ? { EXCALIBUR_RECOVERED: '1' } : {}),
        },
      });
    } catch {
      // Cannot spawn at all — run the session in-process (no supervision, but the user gets
      // a working shell). The in-process armor still guards every catchable fault.
      runInline();
      return;
    }

    child.on('error', () => {
      // Spawn failed asynchronously — same graceful fallback.
      runInline();
    });

    child.on('exit', (code, signal) => {
      // A CLEAN exit is the user leaving (/exit, double-Ctrl-C) → honor it and stop.
      if (signal === null && (code === 0 || code === null)) {
        process.exit(code ?? 0);
        return;
      }
      // Abnormal death (a signal, or a non-zero crash code). Bring the shell back.
      const lived = Date.now() - startedAt;
      fastDeaths = lived < FAST_DEATH_MS ? fastDeaths + 1 : 0;
      if (fastDeaths > MAX_FAST_DEATHS) {
        // Repeated instant deaths = a startup fault respawning won't fix. Stop cleanly.
        try {
          process.stdout.write(
            `\n${notice(`repeated startup failure — stopping (last: ${signal ?? `code ${code}`})`)}\n`,
          );
        } catch {
          /* best-effort */
        }
        process.exit(1);
        return;
      }
      // Restore the terminal a crashed child may have left in raw mode / cursor-hidden, so
      // the recovery notice and the respawned shell render cleanly.
      try {
        if (process.stdin.isTTY === true) {
          process.stdin.setRawMode?.(false);
        }
        process.stdout.write('\u001b[?25h\u001b[0m\n');
      } catch {
        /* best-effort terminal reset */
      }
      try {
        process.stdout.write(`${notice(String(signal ?? `code ${code}`))}\n`);
      } catch {
        /* best-effort */
      }
      // Resume the SAME session so the conversation + history survive the crash.
      launch(true, true);
    });
  };

  launch(opts.continue === true || opts.resume !== undefined, false);
}
