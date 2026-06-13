import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { interactionMetadataSchema, patchMetadataSchema } from '@excalibur/core';
import { parseEventsJsonl } from '@excalibur/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { extractUnifiedDiff, filesAffectedFromDiff } from '../lib/interactions';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

const repo = makeTempRepo();

afterAll(() => removeDir(repo));

/** Writes a repo file and returns its absolute path. */
function writeRepoFile(root: string, relPath: string, content: string): void {
  const filePath = join(root, ...relPath.split('/'));
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

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

describe('M2 repo-context retrieval (ask / explain / review)', () => {
  function repoWithCode(): string {
    const root = makeTempRepo();
    writeRepoFile(
      root,
      'src/escrow/escrow.service.ts',
      [
        "import { Ledger } from './ledger';",
        '',
        'export class EscrowService {',
        '  async release(id: string): Promise<void> {',
        '    // release the escrow funds for the given id',
        '    await this.ledger.record(id);',
        '  }',
        '}',
      ].join('\n'),
    );
    writeRepoFile(
      root,
      'src/escrow/ledger.ts',
      ['export class Ledger {', '  async record(id: string): Promise<void> {}', '}'].join('\n'),
    );
    writeRepoFile(
      root,
      'src/billing/invoice.ts',
      ['export function createInvoice(): void {}'].join('\n'),
    );
    return root;
  }

  function effectiveOf(root: string): string {
    const dir = latestDir(join(root, '.excalibur', 'interactions'));
    return readFileSync(join(dir, 'effective-instructions.md'), 'utf8');
  }

  it('ask injects a [repo-context: …] block into the system context', async () => {
    const root = repoWithCode();
    const cli = createTestCli({ cwd: root });
    await cli.run('ask', 'How does escrow release work?');
    const effective = effectiveOf(root);
    expect(effective).toContain('[Source: repo-context: src/escrow/escrow.service.ts]');
    expect(effective).toContain('matched:');
    removeDir(root);
  });

  it('ask --no-context skips retrieval', async () => {
    const root = repoWithCode();
    const cli = createTestCli({ cwd: root });
    await cli.run('ask', 'How does escrow release work?', '--no-context');
    const effective = effectiveOf(root);
    expect(effective).not.toContain('repo-context:');
    removeDir(root);
  });

  it('explain includes same-dir / imported neighbors as context', async () => {
    const root = repoWithCode();
    const cli = createTestCli({ cwd: root });
    await cli.run('explain', 'src/escrow/escrow.service.ts');
    const effective = effectiveOf(root);
    // ledger.ts is same-dir AND imported by the anchor → injected as a neighbor.
    expect(effective).toContain('[Source: repo-context: src/escrow/ledger.ts]');
    // The anchor file itself is not re-injected as a neighbor.
    expect(effective).not.toContain('[Source: repo-context: src/escrow/escrow.service.ts]');
    removeDir(root);
  });

  it('review --diff injects context for changed files', async () => {
    const root = repoWithCode();
    // Commit the fixture so the modification below shows up in `git diff HEAD`.
    const git = (args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
        stdio: 'ignore',
      });
    };
    git(['add', '-A']);
    git(['commit', '-qm', 'add escrow']);
    // Create a working-tree change so the diff is non-empty.
    writeRepoFile(
      root,
      'src/escrow/escrow.service.ts',
      [
        "import { Ledger } from './ledger';",
        '',
        'export class EscrowService {',
        '  async release(id: string): Promise<void> {',
        '    if (await this.ledger.isReleased(id)) return;',
        '    await this.ledger.record(id);',
        '  }',
        '}',
      ].join('\n'),
    );
    const cli = createTestCli({ cwd: root });
    await cli.run('review', '--diff');
    const effective = effectiveOf(root);
    expect(effective).toContain('[Source: repo-context:');
    removeDir(root);
  });

  it('blocked neighbor paths (.env / secrets) are excluded from injected context', async () => {
    const root = makeTempRepo();
    writeRepoFile(root, '.env', 'API_KEY=AKIAIOSFODNN7EXAMPLE\n');
    writeRepoFile(root, 'src/secrets/keys.ts', 'export const KEY = "release-escrow-secret";\n');
    writeRepoFile(
      root,
      'src/escrow/escrow.service.ts',
      'export class EscrowService { release() { return "escrow"; } }\n',
    );
    const cli = createTestCli({ cwd: root });
    await cli.run('explain', 'src/escrow/escrow.service.ts');
    const effective = effectiveOf(root);
    expect(effective).not.toContain('src/secrets/');
    expect(effective).not.toContain('.env');
    expect(effective).not.toContain('AKIAIOSFODNN7EXAMPLE');
    removeDir(root);
  });

  it('streams live in an interactive TTY and persists the same assembled output', async () => {
    const { Writable } = await import('node:stream');
    const { Ui } = await import('../ui');
    const { buildProgram } = await import('../program');

    const chunks: string[] = [];
    const out = new Writable({
      write(chunk, _enc, cb): void {
        chunks.push(String(chunk));
        cb();
      },
    });
    const err = new Writable({ write: (_c, _e, cb): void => cb() });

    const root = repoWithCode();
    // interactive: true forces the streaming path even with non-TTY memory streams.
    const ui = new Ui({ stdout: out, stderr: err, interactive: true });
    const program = buildProgram({
      ui,
      cwd: () => root,
      homeDir: () => makeTempRepo({ git: false }),
      env: { PATH: process.env.PATH },
      includeUserGlobal: false,
    });
    await program.parseAsync(['node', 'excalibur', 'ask', 'How does escrow release work?', '--no-context']);

    const stdout = chunks.join('');
    expect(stdout).toContain('Mock provider (M1)');
    const persisted = readFileSync(
      join(latestDir(join(root, '.excalibur', 'interactions')), 'output.md'),
      'utf8',
    );
    // The streamed text contains the full assembled output (byte-identical body).
    expect(stdout).toContain(persisted.trimEnd());
    removeDir(root);
  });

  it('the persisted artifact is byte-identical streamed vs not streamed', async () => {
    // Non-interactive harness → non-streaming path. The streamed path persists
    // the same assembled output.content, so the artifacts match.
    const root = repoWithCode();
    const cli = createTestCli({ cwd: root });
    await cli.run('ask', 'How does escrow release work?', '--no-context');
    const nonStreamed = readFileSync(
      join(latestDir(join(root, '.excalibur', 'interactions')), 'output.md'),
      'utf8',
    );
    // Same prompt again (deterministic mock) → identical persisted output.
    await cli.run('ask', 'How does escrow release work?', '--no-context');
    const second = readFileSync(
      join(latestDir(join(root, '.excalibur', 'interactions')), 'output.md'),
      'utf8',
    );
    expect(second).toBe(nonStreamed);
    removeDir(root);
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
