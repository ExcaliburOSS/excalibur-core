import { listMissions, loadMission, type MissionState } from '@excalibur/core';

/**
 * Dashboard data for the meta-orchestrator's MISSION view (M8 #43, dashboard half).
 * Self-contained projection of the persisted mission state (`.excalibur/missions/`)
 * into JSON the `serve` API + Svelte page consume — the capability DAG, per-step
 * status, outcome, and spend. Kept as its OWN module (no edits to the shared
 * `serve.ts`/contracts while the other instance is mid-edit there) so wiring the
 * `/api/missions` + `/api/missions/:id` routes later is a tiny, conflict-free step.
 */

/** A one-line mission summary for the list view. */
export interface MissionListItem {
  id: string;
  goal: string;
  outcome: MissionState['outcome'];
  spentCents: number;
  stepsDone: number;
  stepsTotal: number;
}

/** One node of the mission DAG for the detail view. */
export interface MissionStepDto {
  id: string;
  capability: string;
  objective: string;
  status: string;
  gate: boolean;
  attempts: number;
  dependsOn: string[];
}

/** The full mission detail (the DAG + progress) for the detail view. */
export interface MissionDetailDto {
  id: string;
  goal: string;
  interpretation: string;
  complexity: string;
  risk: string;
  outcome: MissionState['outcome'];
  pausedReason?: string;
  spentCents: number;
  successCriteria: string[];
  steps: MissionStepDto[];
}

const isTerminal = (s: string): boolean => s === 'done' || s === 'skipped';

function summarize(state: MissionState): MissionListItem {
  return {
    id: state.id,
    goal: state.mission.goal,
    outcome: state.outcome,
    spentCents: state.spentCents,
    stepsDone: state.steps.filter((s) => isTerminal(s.status)).length,
    stepsTotal: state.steps.length,
  };
}

/** All checkpointed missions, newest-resumable-first is the caller's concern. */
export function missionsList(repoRoot: string): MissionListItem[] {
  return listMissions(repoRoot)
    .map((id) => loadMission(repoRoot, id))
    .filter((s): s is MissionState => s !== null)
    .map(summarize);
}

/** One mission's full DAG + progress, or null when unknown. */
export function missionDetail(repoRoot: string, id: string): MissionDetailDto | null {
  const state = loadMission(repoRoot, id);
  if (state === null) {
    return null;
  }
  return {
    id: state.id,
    goal: state.mission.goal,
    interpretation: state.mission.interpretation,
    complexity: state.mission.complexity,
    risk: state.mission.risk,
    outcome: state.outcome,
    ...(state.pausedReason !== undefined ? { pausedReason: state.pausedReason } : {}),
    spentCents: state.spentCents,
    successCriteria: state.mission.successCriteria,
    steps: state.steps.map((s) => ({
      id: s.step.id,
      capability: s.step.capability,
      objective: s.step.objective,
      status: s.status,
      gate: s.step.gate,
      attempts: s.attempts,
      dependsOn: s.step.dependsOn,
    })),
  };
}
