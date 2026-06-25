import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionEvent, MissionState } from './supervisor';

/**
 * M5 — mission checkpointing: persist a {@link MissionState} to disk so a LONG
 * job survives a crash, a closed terminal, or a budget/time pause and can be
 * RESUMED later. State is a plain JSON snapshot under
 * `<repo>/.excalibur/missions/<id>/state.json`; wire {@link saveMission} to the
 * supervisor's `onEvent` to checkpoint after every step. Best-effort + dependency
 * free (the same local-files model as runs/plans/memory).
 */

/** The on-disk directory for a mission. */
export function missionDir(repoRoot: string, id: string): string {
  return join(repoRoot, '.excalibur', 'missions', id);
}

/** Writes the mission snapshot (creates the directory). Best-effort — never throws. */
export function saveMission(repoRoot: string, state: Readonly<MissionState>): void {
  try {
    const dir = missionDir(repoRoot, state.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // Checkpointing is best-effort; a write failure must never break the mission.
  }
}

/** Loads a checkpointed mission, or null if absent/corrupt. */
export function loadMission(repoRoot: string, id: string): MissionState | null {
  const file = join(missionDir(repoRoot, id), 'state.json');
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as MissionState;
  } catch {
    return null;
  }
}

/** Lists the ids of all checkpointed missions (newest filesystem order is not guaranteed). */
export function listMissions(repoRoot: string): string[] {
  const dir = join(repoRoot, '.excalibur', 'missions');
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir).filter((id) => existsSync(join(dir, id, 'state.json')));
  } catch {
    return [];
  }
}

/** The ids of missions that are paused (resumable) — for an "excalibur missions" view. */
export function resumableMissions(repoRoot: string): string[] {
  return listMissions(repoRoot).filter((id) => loadMission(repoRoot, id)?.outcome === 'paused');
}

/**
 * A ready-to-use checkpoint sink for `runMission`'s `onEvent`: persists the state
 * after each event so the latest snapshot is always on disk.
 */
export function checkpointSink(
  repoRoot: string,
): (event: MissionEvent, state: Readonly<MissionState>) => void {
  return (_event, state) => saveMission(repoRoot, state);
}
