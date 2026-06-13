import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { PatchStore, type LocalPatch } from '@excalibur/core';
import {
  createEvent,
  serializeEventLine,
  type ExcaliburEventType,
} from '@excalibur/shared';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';

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
    throw new CliUsageError(
      'No local patches found. Generate one first: excalibur patch "<task>".',
    );
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
