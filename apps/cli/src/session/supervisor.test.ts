import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSupervisedChild, supervisorEnabled } from './supervisor';

/**
 * RUN-FIX-24 — the supervisor's gate. The integration proof (a real self-SIGKILL → respawn)
 * lives in scripts/verify-supervisor.mjs; here we lock the routing contract so the parent
 * always supervises an interactive TTY and the supervised child always runs in-process.
 */
describe('supervisor gate', () => {
  const savedEnv = { ...process.env };
  const savedStdin = process.stdin.isTTY;
  const savedStdout = process.stdout.isTTY;

  beforeEach(() => {
    delete process.env['EXCALIBUR_SUPERVISED'];
    delete process.env['EXCALIBUR_NO_SUPERVISOR'];
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    Object.defineProperty(process.stdin, 'isTTY', { value: savedStdin, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdout, configurable: true });
  });

  const setTty = (on: boolean): void => {
    Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: on, configurable: true });
  };

  it('the supervised child runs the session in-process (never re-supervises)', () => {
    process.env['EXCALIBUR_SUPERVISED'] = '1';
    setTty(true);
    expect(isSupervisedChild()).toBe(true);
    expect(supervisorEnabled()).toBe(false);
  });

  it('a fresh interactive TTY launch supervises', () => {
    setTty(true);
    expect(isSupervisedChild()).toBe(false);
    expect(supervisorEnabled()).toBe(true);
  });

  it('a non-TTY (piped / CI) run is never supervised — there is no session to keep', () => {
    setTty(false);
    expect(supervisorEnabled()).toBe(false);
  });

  it('EXCALIBUR_NO_SUPERVISOR=1 opts out (tests / debugging / restricted hosts)', () => {
    process.env['EXCALIBUR_NO_SUPERVISOR'] = '1';
    setTty(true);
    expect(supervisorEnabled()).toBe(false);
  });
});
