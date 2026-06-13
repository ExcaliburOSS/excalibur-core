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
export {
  createExtensionHost,
  workflowCatalog,
  type WorkflowCatalogEntry,
} from './extensions/host';

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
  createBranch,
  getGitInfo,
  getLocalDiff,
  listRecentCommits,
  type GitCommit,
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
  type EffectiveInstructions,
  type EffectiveInstructionsInput,
} from './instructions/effective-instructions';

// Discovery (D-7)
export {
  DiscoveryManager,
  type CreateDiscoverySessionInput,
  type LocalDiscoverySession,
} from './discovery/discovery-manager';

// Core-local errors
export {
  ArtifactRecordError,
  DiscoverySessionNotFoundError,
  GitOperationError,
  InteractionNotFoundError,
  PatchNotFoundError,
} from './errors';
