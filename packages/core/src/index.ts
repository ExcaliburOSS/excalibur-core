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
  collectExtensionMcpServers,
  createExtensionHost,
  extensionPolicyFromConfig,
  withExtensionMcpServers,
  workflowCatalog,
  type WorkflowCatalogEntry,
} from './extensions/host';

// Init
export {
  applyInitPlan,
  enrichAgentsMd,
  generateInitPlan,
  type AgentsMdChat,
  type AgentsMdEnrichment,
  type ApplyInitPlanOptions,
  type ApplyInitPlanResult,
  type EnrichAgentsMdOptions,
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

// Automatic swarm sizing (deterministic allocator) + real fan-out/fan-in execution (M3)
export {
  planAgentAllocation,
  type AgentAllocation,
  type AgentAllocationInput,
  type Subtask,
} from './swarm/agent-allocation';
export {
  savePlan,
  listPlans,
  readPlan,
  plansDir,
  slugify,
  type PlanStatus,
  type SavePlanInput,
  type StoredPlan,
} from './plans/plan-store';
export {
  planVerificationMesh,
  aggregateMesh,
  MESH_LENSES,
  type MeshLens,
  type MeshMode,
  type MeshPlan,
  type MeshPlanInput,
  type MeshIssue,
  type MeshVerdict,
  type MeshResult,
} from './verification/verification-mesh';
export { runVerificationMesh, type RunMeshInput } from './verification/verification-runner';
export {
  runSwarm,
  runSwarmStaged,
  type RunSwarmOptions,
  type SwarmConflict,
  type SwarmGrade,
  type SwarmLane,
  type SwarmLaneContext,
  type SwarmLaneGrader,
  type SwarmLaneProgress,
  type SwarmLaneResult,
  type SwarmLaneRunner,
  type SwarmResult,
} from './swarm/run-swarm';
export {
  capTotalAgents,
  chooseConcurrency,
  SWARM_MAX_TOTAL_AGENTS,
  type ConcurrencyInput,
} from './swarm/concurrency';
export { topologicalWaves, type DependencyNode } from './swarm/toposort';

// Runs
export { RunManager, type CreateRunInput, type ModelCallLine } from './runs/run-manager';

// Claim Ledger (evidence-linked truth check — plan P2.4)
export {
  buildClaimLedger,
  extractAssertedClaims,
  ledgerBlocks,
  summarizeLedger,
  type ClaimKind,
  type ClaimStatus,
  type ClaimVerdict,
  type ClaimEvidence,
} from './claims/claim-ledger';

// Insights (cross-run lens — plan P2.5)
export {
  aggregateInsights,
  collectInsights,
  type RunInsight,
  type InsightsReport,
  type CountCost,
  type DayBucket,
  type CollectInsightsOptions,
} from './insights/insights';

// Pre-flight estimate (dry-run forecast — plan differentiator #2)
export { estimateRun, type RunEstimate, type EstimateInput } from './insights/estimate';

// Structured output (provider-agnostic --json-schema — plan P1.12)
export {
  askStructured,
  buildSchemaInstruction,
  extractJsonValue,
  extractJsonValues,
  validateAgainstSchema,
  type JsonSchema,
  type StructuredAskInput,
  type StructuredAskResult,
} from './structured/structured-output';

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

// Knowledge Compounding (plan §"Knowledge Compounding") — project memory (OSS slice)
export * from './memory';

// Native deep-research pipeline (F7) — search → fetch → verify → cited synthesis.
export * from './research/citations';
export * from './research/claim-verifier';
export * from './research/research-pipeline';

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
export {
  executeLocalRun,
  BudgetExceededError,
  type ExecuteLocalRunInput,
} from './engine/execute-local-run';
export {
  RunController,
  type RunHandle,
  type StartRunOptions,
  type RunControllerStatus,
  type PendingApproval,
} from './engine/run-controller';

// Custom slash commands (P1.6)
export {
  loadCustomCommands,
  expandCustomCommand,
  shellExecIn,
  type CustomCommand,
  type CommandExec,
  type LoadCustomCommandsOptions,
  type ExpandCommandOptions,
} from './commands/custom-commands';

// Self-contained custom agents (P1.7)
export {
  loadCustomAgents,
  resolveCustomAgent,
  parseAgentFile,
  type CustomAgent,
  type AgentPermissions,
  type LoadCustomAgentsOptions,
} from './agents/custom-agents';

// Git helpers
export {
  addWorktree,
  applyPatch,
  checkPatchApplies,
  commitAll,
  createBranch,
  getGitIdentity,
  getGitInfo,
  excludePathFromGit,
  getLocalDiff,
  stageAll,
  hasCommits,
  listRecentCommits,
  removeWorktree,
  resetWorktree,
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
  classifyTurnIntent,
  classifyTurnDecision,
  buildIntentPrompt,
  buildDecisionPrompt,
  parseTurnIntent,
  parseTurnConfidence,
  parseTurnDecision,
  riskOfShape,
  decidePosture,
  type StructuralInput,
  type StatusLineModel,
  type BuildStatusLineInput,
  type TurnIntent,
  type TurnConfidence,
  type TurnDecision,
  type ShapeRisk,
  type RoutePosture,
  type IntentContext,
  type IntentModel,
} from './sessions/intent-router';

// Core-local errors
export {
  ArtifactRecordError,
  DiscoverySessionNotFoundError,
  GitOperationError,
  InteractionNotFoundError,
  PatchNotFoundError,
} from './errors';
