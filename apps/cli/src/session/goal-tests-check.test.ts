import { describe, expect, it } from 'vitest';
import { isTestyGoal, runConfiguredTestsCheck } from './repl';

describe('isTestyGoal', () => {
  it('matches test/build/lint goals (en + es)', () => {
    expect(isTestyGoal('keep going until the tests pass')).toBe(true);
    expect(isTestyGoal('fix the build')).toBe(true);
    expect(isTestyGoal('make it typecheck')).toBe(true);
    expect(isTestyGoal('no pares hasta que pasen los tests')).toBe(true);
    expect(isTestyGoal('hasta que esté verde')).toBe(true);
  });

  it('does not match unrelated goals', () => {
    expect(isTestyGoal('add a pagination feature to the logs view')).toBe(false);
    expect(isTestyGoal('explain the auth flow')).toBe(false);
  });
});

describe('runConfiguredTestsCheck', () => {
  it('returns undefined when no test command is configured', () => {
    expect(runConfiguredTestsCheck(process.cwd(), undefined, undefined)).toBeUndefined();
    expect(runConfiguredTestsCheck(process.cwd(), '   ', undefined)).toBeUndefined();
  });

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
  });

  it('fails (never throws) when the command exits non-zero', async () => {
    const check = runConfiguredTestsCheck(
      process.cwd(),
      `${process.execPath} -e process.exit(1)`,
      undefined,
    );
    const result = await check!();
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('failed');
  });
});
