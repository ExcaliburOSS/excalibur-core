import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { interactionMetadataSchema, patchMetadataSchema } from '@excalibur/core';
import { parseEventsJsonl } from '@excalibur/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { extractUnifiedDiff, filesAffectedFromDiff } from '../lib/interactions';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

const repo = makeTempRepo();

afterAll(() => removeDir(repo));

function latestDir(base: string): string {
  const entries = readdirSync(base).sort();
  const last = entries[entries.length - 1];
  expect(last).toBeDefined();
  return join(base, last as string);
}

describe('ask / explain / review (lightweight interactions)', () => {
  it('ask prints a mock answer and writes the InteractionStore artifact set', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('ask', 'Where is escrow release implemented?');

    expect(cli.stdout()).toContain('Mock provider (M1)');
    expect(cli.stdout()).toContain('ask → ask-repo');

    const dir = latestDir(join(repo, '.excalibur', 'interactions'));
    expect(existsSync(join(dir, 'input.md'))).toBe(true);
    expect(existsSync(join(dir, 'output.md'))).toBe(true);
    expect(existsSync(join(dir, 'effective-instructions.md'))).toBe(true);

    const metadata = interactionMetadataSchema.parse(
      JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')),
    );
    expect(metadata.command).toBe('ask');
    expect(metadata.workflow).toBe('ask-repo');
    expect(metadata.autonomyLevel).toBe(1);
    expect(metadata.provider).toBe('mock');
    // CLAUDE.md is a detected, trusted instruction source (ISD-5).
    expect(metadata.instructionSources).toContain('CLAUDE.md');
  });

  it('prepends the effective instructions to the stored context', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('ask', 'What changed?');
    const dir = latestDir(join(repo, '.excalibur', 'interactions'));
    const effective = readFileSync(join(dir, 'effective-instructions.md'), 'utf8');
    expect(effective).toContain('[Source: CLAUDE.md]');
    expect(effective).toContain('Use pnpm');
  });

  it('explain requires an existing file (usage error)', async () => {
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('explain', 'src/missing.ts')).rejects.toThrow(/File not found/);
  });

  it('explain stores an interaction for a real file', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('explain', 'src/service.ts');
    const dir = latestDir(join(repo, '.excalibur', 'interactions'));
    const metadata = interactionMetadataSchema.parse(
      JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')),
    );
    expect(metadata.command).toBe('explain');
  });

  it('review of a clean working tree exits gracefully', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('review', '--diff');
    expect(cli.stdout()).toContain('nothing to review');
  });

  it('review of a file maps to review-only at Level 0', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('review', 'src/service.ts');
    expect(cli.stdout()).toContain('review → review-only');
    const dir = latestDir(join(repo, '.excalibur', 'interactions'));
    const metadata = interactionMetadataSchema.parse(
      JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')),
    );
    expect(metadata.autonomyLevel).toBe(0);
    expect(metadata.workflow).toBe('review-only');
  });
});

describe('patch lifecycle (OSS spec §3.2)', () => {
  it('patch writes the PatchStore artifact set and shows the diff', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('patch', 'Fix duplicated release in src/escrow/escrow.service.ts', '--yes');

    expect(cli.stdout()).toContain('Files affected:');
    expect(cli.stdout()).toContain('Safety: standard-safe');

    const dir = latestDir(join(repo, '.excalibur', 'patches'));
    for (const file of ['input.md', 'effective-instructions.md', 'diff.patch', 'summary.md', 'metadata.json']) {
      expect(existsSync(join(dir, file)), `${file} must exist`).toBe(true);
    }
    const metadata = patchMetadataSchema.parse(
      JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')),
    );
    expect(metadata.workflow).toBe('propose-patch');
    expect(metadata.autonomyLevel).toBe(2);
    // --yes keeps the SAFE default for "Apply patch? [y/N]" — not applied.
    expect(metadata.status).toBe('proposed');
    expect(readFileSync(join(dir, 'diff.patch'), 'utf8')).toContain('+++ b/');
  });

  it('apply marks the patch applied with a simulated event', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('apply', '--yes');
    const dir = latestDir(join(repo, '.excalibur', 'patches'));
    const metadata = patchMetadataSchema.parse(
      JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')),
    );
    expect(metadata.status).toBe('applied');
    const events = parseEventsJsonl(readFileSync(join(dir, 'events.jsonl'), 'utf8'));
    const applied = events.find((event) => event.type === 'patch_applied');
    expect(applied).toBeDefined();
    expect(applied?.payload['simulated']).toBe(true);
  });

  it('reject marks the patch rejected', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('reject');
    const dir = latestDir(join(repo, '.excalibur', 'patches'));
    const metadata = patchMetadataSchema.parse(
      JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')),
    );
    expect(metadata.status).toBe('rejected');
  });

  it('branch creates a real git branch named excalibur/<id>', async () => {
    const cli = createTestCli({ cwd: repo });
    await cli.run('branch', '--yes');
    const branches = execFileSync('git', ['branch', '--list', 'excalibur/*'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(branches).toMatch(/excalibur\/patch_\d{8}_\d{6}/);
  });

  it('apply without any patches is a usage error', async () => {
    const empty = makeTempRepo({ git: false });
    const cli = createTestCli({ cwd: empty });
    await expect(cli.run('apply', '--yes')).rejects.toThrow(/No local patches/);
    removeDir(empty);
  });
});

describe('diff helpers', () => {
  it('extracts unified diffs from fenced blocks and lists affected files', () => {
    const content = 'before\n```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+x\n```\nafter';
    const diff = extractUnifiedDiff(content);
    expect(diff).toContain('+++ b/src/a.ts');
    expect(filesAffectedFromDiff(diff ?? '')).toEqual(['src/a.ts']);
    expect(extractUnifiedDiff('no diff here')).toBeNull();
  });
});
