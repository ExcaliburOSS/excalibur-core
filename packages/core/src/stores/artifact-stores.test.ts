import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InteractionNotFoundError, PatchNotFoundError } from '../errors';
import { makeTempDir, removeDir } from '../test-utils';
import { InteractionStore, PatchStore } from './artifact-stores';

describe('PatchStore', () => {
  let repoRoot: string;
  let store: PatchStore;

  beforeEach(() => {
    repoRoot = makeTempDir();
    store = new PatchStore(repoRoot);
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('round-trips a patch artifact set', () => {
    const created = store.create({
      input: 'Fix duplicated webhook handling',
      effectiveInstructions: 'Effective project instructions:\n\n[Source: CLAUDE.md]\n\nBe careful.',
      diff: '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1,2 @@\n+guard();\n',
      summary: '# Patch summary\nAdds an idempotency guard.',
      model: 'mock-model',
      provider: 'mock',
      instructionSources: ['CLAUDE.md'],
      warnings: [],
      costCents: 0,
    });

    expect(created.id).toMatch(/^patch_\d{8}_\d{6}$/);
    expect(created.dir).toBe(join(repoRoot, '.excalibur', 'patches', created.id));
    expect(created.metadata.status).toBe('proposed');
    expect(created.metadata.command).toBe('patch');
    expect(created.metadata.workflow).toBe('propose-patch');
    expect(created.metadata.autonomyLevel).toBe(2);
    expect(created.metadata.instructionSources).toEqual(['CLAUDE.md']);

    // The onboarding §7 file set.
    for (const fileName of [
      'input.md',
      'effective-instructions.md',
      'diff.patch',
      'summary.md',
      'metadata.json',
    ]) {
      expect(existsSync(join(created.dir, fileName)), fileName).toBe(true);
    }
    expect(readFileSync(join(created.dir, 'diff.patch'), 'utf8')).toContain('+guard();');
    expect(store.readArtifact(created.id, 'summary.md')).toContain('idempotency guard');

    const fetched = store.get(created.id);
    expect(fetched.metadata).toEqual(created.metadata);

    const updated = store.update(created.id, {
      status: 'applied',
      completedAt: new Date().toISOString(),
    });
    expect(updated.metadata.status).toBe('applied');
    expect(store.get(created.id).metadata.status).toBe('applied');
  });

  it('lists patches and produces unique ids for same-second creations', () => {
    const a = store.create({ input: 'a', effectiveInstructions: '', diff: '', summary: '' });
    const b = store.create({ input: 'b', effectiveInstructions: '', diff: '', summary: '' });
    expect(a.id).not.toBe(b.id);
    expect(store.list().map((patch) => patch.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('throws PatchNotFoundError with a stable code', () => {
    expect(() => store.get('patch_19700101_000000')).toThrowError(PatchNotFoundError);
    try {
      store.get('patch_19700101_000000');
      expect.unreachable();
    } catch (error) {
      expect((error as PatchNotFoundError).code).toBe('patch_not_found');
    }
  });
});

describe('InteractionStore', () => {
  let repoRoot: string;
  let store: InteractionStore;

  beforeEach(() => {
    repoRoot = makeTempDir();
    store = new InteractionStore(repoRoot);
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('round-trips an interaction artifact set', () => {
    const created = store.create({
      command: 'ask',
      input: 'Where is escrow release implemented?',
      effectiveInstructions: 'Effective project instructions:',
      output: '> Mock provider (M1)\n\nIt lives in src/escrow/escrow.service.ts.',
      instructionSources: ['AGENTS.md'],
      warnings: ['Package-manager conflict: …'],
    });

    expect(created.id).toMatch(/^int_\d{8}_\d{6}$/);
    expect(created.metadata.status).toBe('completed');
    expect(created.metadata.command).toBe('ask');
    expect(created.metadata.workflow).toBe('ask-repo');
    expect(created.metadata.autonomyLevel).toBe(1);
    expect(created.metadata.warnings).toHaveLength(1);

    for (const fileName of ['input.md', 'effective-instructions.md', 'output.md', 'metadata.json']) {
      expect(existsSync(join(created.dir, fileName)), fileName).toBe(true);
    }
    expect(store.readArtifact(created.id, 'output.md')).toContain('escrow.service.ts');

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.metadata).toEqual(created.metadata);
  });

  it('throws InteractionNotFoundError for unknown ids', () => {
    expect(() => store.get('int_19700101_000000')).toThrowError(InteractionNotFoundError);
  });
});
