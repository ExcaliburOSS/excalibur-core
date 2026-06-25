/**
 * The meta-orchestrator: interpret a natural goal, then PROACTIVELY compose
 * Excalibur's full toolbox into a capability DAG and (M4+) drive it adaptively.
 * This barrel exposes the planning brain (M1–M3); the supervisor, long-job
 * checkpointing, and the proactive trigger land in later milestones.
 */
export * from './types';
export * from './capability-catalog';
export * from './interpret-mission';
export * from './plan-strategy';
export * from './supervisor';
export * from './reassess';
export * from './mission-store';
