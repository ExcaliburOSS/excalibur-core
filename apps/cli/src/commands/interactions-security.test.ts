import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactDiff } from '../lib/context';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

/**
 * Security regression tests for the lightweight assistant commands
 * (Build Contract §4.4): blocked-path enforcement and secret redaction for
 * user-supplied `--file` / path arguments and the local `--diff`. Without
 * these guards `excalibur explain .env` / `review src/secrets/keys.ts` would
 * slurp credential files straight into the model prompt and the stored
 * interaction artifact.
 */

const SK_KEY = 'sk-test1234567890abcdefABCDEF1234567890';

let repo: string;

beforeEach(() => {
  repo = makeTempRepo();
  // A secret-bearing .env (blocked by DEFAULT_BLOCKED_PATHS) and a tracked
  // file under secrets/ (also blocked).
  writeFileSync(join(repo, '.env'), `API_KEY=${SK_KEY}\n`, 'utf8');
  mkdirSync(join(repo, 'src', 'secrets'), { recursive: true });
  writeFileSync(join(repo, 'src', 'secrets', 'keys.ts'), `export const key = '${SK_KEY}';\n`, 'utf8');
});

afterEach(() => removeDir(repo));

/** Reads every interaction's output.md so we can assert on what was persisted. */
function interactionOutputs(): string {
  const base = join(repo, '.excalibur', 'interactions');
  let combined = '';
  for (const dir of readdirSync(base)) {
    combined += readFileSync(join(base, dir, 'output.md'), 'utf8');
    combined += readFileSync(join(base, dir, 'input.md'), 'utf8');
  }
  return combined;
}

describe('explain blocked-path enforcement', () => {
  it('refuses to read a blocked .env file', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('explain', '.env')).rejects.toThrow(/blocked|Refusing/i);
  });

  it('refuses to read a file under a blocked secrets/ directory', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('explain', 'src/secrets/keys.ts')).rejects.toThrow(/blocked|Refusing/i);
  });
});

describe('review blocked-path enforcement and diff redaction', () => {
  it('refuses to review a blocked secrets file', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('review', 'src/secrets/keys.ts')).rejects.toThrow(/blocked|Refusing/i);
  });

  it('redactDiff masks secrets in a unified diff', () => {
    const diff = `diff --git a/src/service.ts b/src/service.ts\n+export const apiKey = '${SK_KEY}';\n`;
    const redacted = redactDiff(diff);
    expect(redacted).not.toContain(SK_KEY);
    expect(redacted).toContain('[REDACTED]');
  });

  it('never leaks a diff secret into the prompt output or stored interaction', async () => {
    // Modify an already-tracked file so the credential shows up in
    // `git diff HEAD` (untracked files do not appear there).
    writeFileSync(
      join(repo, 'src', 'service.ts'),
      `export const apiKey = '${SK_KEY}';\n`,
      'utf8',
    );
    const cli = createTestCli({ cwd: repo });
    await cli.run('review', '--diff');

    // The raw key must not reach the terminal output nor the persisted
    // input.md / output.md (the MockProvider quotes the redacted prompt).
    expect(cli.stdout()).not.toContain(SK_KEY);
    expect(interactionOutputs()).not.toContain(SK_KEY);
  });
});

describe('ask blocked-path enforcement and file redaction', () => {
  it('refuses --file .env', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('ask', 'What is this?', '--file', '.env')).rejects.toThrow(
      /blocked|Refusing/i,
    );
  });

  it('redacts secrets in an allowed context file', async () => {
    // Allowed file (not blocked) that nonetheless carries a credential.
    writeFileSync(
      join(repo, 'src', 'settings.ts'),
      `export const token = '${SK_KEY}';\n`,
      'utf8',
    );
    const cli = createTestCli({ cwd: repo });
    await cli.run('ask', 'Summarise the settings', '--file', 'src/settings.ts');

    expect(cli.stdout()).not.toContain(SK_KEY);
    expect(interactionOutputs()).not.toContain(SK_KEY);
  });
});
