import { describe, expect, it } from 'vitest';
import { goalMaxIterations, runConfiguredTestsCheck } from './repl';

describe('goalMaxIterations (config-driven, no hard-coded const)', () => {
  it('defaults to 6 when unconfigured', () => {
    expect(goalMaxIterations({} as never)).toBe(6);
  });
  it('honors orchestration.goalMaxIterations from config', () => {
    expect(goalMaxIterations({ orchestration: { goalMaxIterations: 12 } } as never)).toBe(12);
  });
});

describe('runConfiguredTestsCheck', () => {
  it('returns undefined when no test command is configured', () => {
    expect(runConfiguredTestsCheck(process.cwd(), undefined, undefined)).toBeUndefined();
    expect(runConfiguredTestsCheck(process.cwd(), '   ', undefined)).toBeUndefined();
  });

  // Generous timeouts: these spawn a real `node` process, which can be slow to
  // start under full-suite parallelism (other files spawn processes too).
  it('passes when the command exits 0', async () => {
    const check = runConfiguredTestsCheck(
      process.cwd(),
      `${process.execPath} -e process.exit(0)`,
      undefined,
    );
    expect(check).toBeDefined();
    const result = await check!();
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('passed');
  }, 30_000);

  it('fails (never throws) when the command exits non-zero', async () => {
    const check = runConfiguredTestsCheck(
      process.cwd(),
      `${process.execPath} -e process.exit(1)`,
      undefined,
    );
    const result = await check!();
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('failed');
  }, 30_000);
});
