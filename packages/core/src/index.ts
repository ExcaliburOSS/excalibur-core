/**
 * @excalibur/core — the Excalibur core engine (Build Contract §4.6):
 * `.excalibur/` configuration, extension host wiring, init planning, local
 * runs/patches/interactions, workflow selection, the local M1 execution
 * engine, git helpers, daily/weekly reports, the effective-instruction
 * builder (ISD) and local Discovery sessions.
 */

// Config
export {
  EXCALIBUR_DIR,
  loadExcaliburConfig,
  type LoadedExcaliburConfig,
} from './config/load-config';

// Extension host
export { createExtensionHost, workflowCatalog, type WorkflowCatalogEntry } from './extensions/host';

// Init
export {
  applyInitPlan,
  generateInitPlan,
  type ApplyInitPlanOptions,
  type ApplyInitPlanResult,
  type GenerateInitPlanOptions,
  type InitMode,
  type InitPlan,
  type InitPlanFile,
} from './init/init-plan';

// Onboarding helpers
export {
  classifyTaskIntent,
  COMMAND_DEFAULTS,
  DEFAULT_SAFETY_PRESET_ID,
  permissionEngineForConfig,
  SAFETY_PRESETS,
  type CommandDefault,
  type CommandEntity,
  type SafetyPreset,
  type TaskIntent,
  type TaskType,
} from './onboarding/onboarding';

// Runs
export { RunManager, type CreateRunInput, type ModelCallLine } from './runs/run-manager';

// Turn receipt (post-turn summary derived from the event stream)
export {
  buildTurnSummary,
  parseDiffStat,
  changeGlyph,
  turnSummaryToMarkdown,
  type TurnSummary,
  type TurnTier,
  type ChangedFile,
  type TurnCheck,
  type TurnMetrics,
  type NextHint,
} from './runs/turn-summary';

// Replay / time-machine (replay · inspect · explain · annotate)
export {
  loadReplay,
  reconstructStateAt,
  nextStepOfKind,
  prevStepOfKind,
  phaseBoundaries,
  loadAnnotations,
  addAnnotation,
  annotationsForStep,
  annotationSchema,
  type ReplayModel,
  type ReplayStep,
  type ReconstructedState,
  type PhaseBoundary,
  type JumpKind,
  type Annotation,
  type AddAnnotationInput,
  type TokenTotals,
} from './replay/replay';

// Replay / time-machine — fork-from-cache + undo-to-checkpoint (T2)
export {
  planFork,
  reconstructConversationPrefix,
  restampEventsForFork,
  planUndo,
  type ForkPlan,
  type UndoPlan,
} from './replay/fork';

// Context compaction (plan §"Compactación de contexto") — the M-Shell offline slice
export * from './compaction';

// Local artifact stores (ONB-8)
export {
  InteractionStore,
  PatchStore,
  interactionMetadataSchema,
  patchMetadataSchema,
  type CreateInteractionInput,
  type CreatePatchInput,
  type InteractionMetadata,
  type InteractionStatus,
  type LocalInteraction,
  type LocalPatch,
  type PatchMetadata,
  type PatchStatus,
  type StoredArtifact,
} from './stores/artifact-stores';

// Workflow selection
export {
  selectWorkflow,
  type SelectWorkflowInput,
  type SelectWorkflowResult,
} from './selection/select-workflow';

// Engine
export { executeLocalRun, type ExecuteLocalRunInput } from './engine/execute-local-run';

// Git helpers
export {
  addWorktree,
  applyPatch,
  checkPatchApplies,
  commitAll,
  createBranch,
  getGitIdentity,
  getGitInfo,
  getLocalDiff,
  hasCommits,
  listRecentCommits,
  removeWorktree,
  revParse,
  type GitCommit,
  type GitIdentity,
  type GitInfo,
} from './git/git';

// Reports (AA-8)
export {
  dailyReportFileName,
  generateDailyReport,
  generateWeeklyPlan,
  isoWeek,
  weeklyPlanFileName,
  writeReport,
  type ReportInput,
} from './reports/reports';

// Effective instructions (ISD)
export {
  EffectiveInstructionBuilder,
  INSTRUCTION_SOURCE_CHAR_CAP,
  INSTRUCTION_TOTAL_CHAR_CAP,
  SUMMARIZED_MARKER,
  type AdditionalContextSource,
  type EffectiveInstructions,
  type EffectiveInstructionsInput,
} from './instructions/effective-instructions';
export {
  buildRepoContextSources,
  formatHitsAsSources,
  type BuildRepoContextInput,
} from './instructions/repo-context';

// Discovery (D-7)
export {
  DiscoveryManager,
  type CreateDiscoverySessionInput,
  type LocalDiscoverySession,
} from './discovery/discovery-manager';

// Sessions (M-Shell Slice A)
export {
  SessionStore,
  PROMPT_HISTORY_CAP,
  sessionMetadataSchema,
  sessionTurnSchema,
  sessionStatusSchema,
  type LocalSession,
  type SessionTurn,
  type SessionMetadata,
  type SessionStatus,
  type SessionTurnRole,
  type SessionTurnKind,
  type CreateSessionInput,
  type AppendTurnInput,
} from './sessions/session-store';
export {
  parseStructuralInput,
  buildStatusLineModel,
  classifyGoalIntent,
  type StructuralInput,
  type StatusLineModel,
  type BuildStatusLineInput,
  type GoalIntent,
} from './sessions/intent-router';

// Core-local errors
export {
  ArtifactRecordError,
  DiscoverySessionNotFoundError,
  GitOperationError,
  InteractionNotFoundError,
  PatchNotFoundError,
} from './errors';
