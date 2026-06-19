import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GitOperationError,
  PatchStore,
  applyPatch,
  getGitInfo,
  type LocalPatch,
} from '@excalibur/core';
import { createEvent, serializeEventLine, type ExcaliburEventType } from '@excalibur/shared';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { filesAffectedFromDiff } from './interactions';

/**
 * Patch lifecycle helpers (`apply` / `branch` / `reject`, OSS spec §3.2).
 * Patch directories carry their own `events.jsonl` so the lifecycle stays
 * auditable and Enterprise-ingestable.
 */

export function resolvePatch(deps: CliDeps, id: string | undefined): LocalPatch {
  const store = new PatchStore(deps.cwd());
  if (id !== undefined) {
    return store.get(id);
  }
  const patches = store.list();
  const latest = patches[patches.length - 1];
  if (latest === undefined) {
    throw new CliUsageError(deps.t('patches.noLocalPatches'));
  }
  return latest;
}

export function appendPatchEvent(
  patch: LocalPatch,
  type: ExcaliburEventType,
  payload: Record<string, unknown>,
): void {
  const event = createEvent({ runId: null, type, sessionId: patch.id, payload });
  appendFileSync(join(patch.dir, 'events.jsonl'), `${serializeEventLine(event)}\n`, 'utf8');
}

/**
 * Applies a stored patch's `diff.patch` to the working tree with REAL `git apply`
 * (M2 — no more simulation), records a real `patch_applied` event and marks the
 * patch `applied`. Shared by `excalibur apply` and the inline apply of
 * `excalibur patch`. The caller is responsible for confirmation; this performs
 * the mutation. Throws {@link CliUsageError} when there is no git repo, the diff
 * is empty, or the patch does not apply.
 */
export function applyStoredPatch(deps: CliDeps, patch: LocalPatch): { filesAffected: string[] } {
  const repoRoot = deps.cwd();
  if (!getGitInfo(repoRoot).isRepo) {
    throw new CliUsageError(deps.t('patches.notAGitRepo', { id: patch.id, repoRoot }));
  }
  const store = new PatchStore(repoRoot);
  const diff = store.readArtifact(patch.id, 'diff.patch') ?? '';
  if (diff.trim().length === 0) {
    throw new CliUsageError(deps.t('patches.emptyDiff', { id: patch.id }));
  }
  if (patch.metadata.diffApplies === false) {
    deps.ui.warn(deps.t('patches.diffDidNotValidate', { id: patch.id }));
  }
  try {
    applyPatch(repoRoot, diff);
  } catch (error) {
    if (error instanceof GitOperationError) {
      throw new CliUsageError(
        deps.t('patches.didNotApply', { id: patch.id, message: error.message }),
      );
    }
    throw error;
  }
  const filesAffected = filesAffectedFromDiff(diff);
  appendPatchEvent(patch, 'patch_applied', { patchId: patch.id, filesAffected });
  store.update(patch.id, { status: 'applied', completedAt: new Date().toISOString() });
  return { filesAffected };
}
