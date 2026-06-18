import { z } from 'zod';
import {
  agentRoleSchema,
  autonomyLevelSchema,
  phaseTypeSchema,
  workflowModeSchema,
  type AgentRole,
  type AutonomyLevel,
  type PhaseType,
  type WorkflowMode,
} from '@excalibur/shared';

/**
 * Workflow and methodology definition schemas (Build Contract §4.2).
 *
 * A workflow is executable (ordered phases with types the engine understands);
 * a methodology is conceptual/prescriptive (philosophy, guidance, artifacts).
 * Both are plain YAML files: Git-versionable, editable by teams and shared
 * verbatim between Excalibur Core and Excalibur Enterprise.
 */

/** Approval requirement attached to a single workflow phase. */
export const phaseApprovalSchema = z.enum(['required', 'optional', 'none']);
export type PhaseApproval = z.infer<typeof phaseApprovalSchema>;

/** Failure handling policy for a workflow phase. */
export const phaseOnFailureSchema = z.enum(['abort', 'continue', 'retry']);
export type PhaseOnFailure = z.infer<typeof phaseOnFailureSchema>;

export interface WorkflowPhase {
  id: string;
  name: string;
  type: PhaseType;
  role?: AgentRole;
  /** Defaults to true; normalized to false when `optional: true` is declared. */
  required?: boolean;
  /** Declarative sugar: `optional: true` is normalized to `required: false`. */
  optional?: boolean;
  /**
   * Swarm sizing for the phase: `'auto'` (default when absent) lets
   * `planAgentAllocation` size it; a number is an explicit override/cap. The
   * developer never has to fix the count.
   */
  agents?: 'auto' | number;
  /** Fan-out/fan-in for agent_work phases (`'sequential'` default). */
  parallelism?: 'sequential' | 'parallel';
  /** Whether the phase should run in an isolated branch/worktree. */
  worktree?: boolean;
  modifiesFiles?: boolean;
  commands?: string[];
  /** Resolve commands from `.excalibur/config.yaml` detected commands. */
  commandsFromConfig?: boolean;
  /** Artifact file name produced by the phase (e.g. `summary.md`). */
  output?: string;
  approval?: PhaseApproval;
  requiresHumanConfirmation?: boolean;
  /** Defaults to 'abort'. */
  onFailure?: PhaseOnFailure;
  maxRetries?: number;
}

const workflowPhaseObjectSchema = z.object({
  id: z.string().min(1, 'phase id must be a non-empty string'),
  name: z.string().min(1, 'phase name must be a non-empty string'),
  type: phaseTypeSchema,
  role: agentRoleSchema.optional(),
  required: z.boolean().optional(),
  optional: z.boolean().optional(),
  // Swarm sizing: the developer never fixes the count — `'auto'` (the default
  // when absent) lets `planAgentAllocation` size the swarm; a number is an
  // explicit override/cap (plan §"Asignación automática de agentes").
  agents: z.union([z.literal('auto'), z.number().int().min(1)]).optional(),
  // Fan-out/fan-in for agent_work phases: `parallel` runs the sized swarm in
  // isolated worktrees and merges; `sequential` (default) runs one at a time.
  parallelism: z.enum(['sequential', 'parallel']).optional(),
  worktree: z.boolean().optional(),
  modifiesFiles: z.boolean().optional(),
  commands: z.array(z.string().min(1)).optional(),
  commandsFromConfig: z.boolean().optional(),
  output: z.string().min(1).optional(),
  approval: phaseApprovalSchema.optional(),
  requiresHumanConfirmation: z.boolean().optional(),
  onFailure: phaseOnFailureSchema.optional(),
  maxRetries: z.number().int().min(0).optional(),
});

function normalizePhase(phase: z.infer<typeof workflowPhaseObjectSchema>): WorkflowPhase {
  return {
    ...phase,
    // `optional: true` is declarative sugar for `required: false` (Build Contract §4.2).
    required: phase.optional === true ? false : (phase.required ?? true),
    onFailure: phase.onFailure ?? 'abort',
  };
}

/**
 * Schema for one workflow phase. Parsing normalizes `optional: true` to
 * `required: false` and fills the documented defaults (`required: true`,
 * `onFailure: 'abort'`).
 */
export const workflowPhaseSchema = workflowPhaseObjectSchema
  .superRefine((phase, ctx) => {
    // `required:true` + `optional:true` is a contradiction — silently letting
    // `optional` win would mask an authoring mistake. Reject it explicitly.
    if (phase.required === true && phase.optional === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a phase cannot be both required:true and optional:true',
        path: ['optional'],
      });
    }
  })
  .transform(normalizePhase);

export interface WorkflowDefaults {
  model?: string;
  commands?: string[];
}

export interface WorkflowDefinition {
  id: string;
  /** Optional discriminator used by declarative extension files. */
  type?: 'workflow';
  name: string;
  description?: string;
  mode: WorkflowMode;
  /** Defaults to all levels: [0, 1, 2, 3, 4]. */
  supportedAutonomyLevels?: AutonomyLevel[];
  inputs?: string[];
  defaults?: WorkflowDefaults;
  phases: WorkflowPhase[];
}

export const ALL_AUTONOMY_LEVELS: readonly AutonomyLevel[] = [0, 1, 2, 3, 4];

const workflowDefinitionObjectSchema = z.object({
  id: z.string().min(1, 'workflow id must be a non-empty string'),
  type: z.literal('workflow').optional(),
  name: z.string().min(1, 'workflow name must be a non-empty string'),
  description: z.string().optional(),
  mode: workflowModeSchema,
  supportedAutonomyLevels: z.array(autonomyLevelSchema).optional(),
  inputs: z.array(z.string().min(1)).optional(),
  defaults: z
    .object({
      model: z.string().min(1).optional(),
      commands: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  phases: z.array(workflowPhaseSchema).min(1, 'a workflow must declare at least one phase'),
});

/**
 * Schema for a full workflow definition. `supportedAutonomyLevels` defaults
 * to all levels when omitted.
 */
export const workflowDefinitionSchema = workflowDefinitionObjectSchema
  .superRefine((definition, ctx) => {
    // Phase ids must be unique: events are attributed to a phase by id, so a
    // duplicate would merge two phases in the rail / reduceRail and corrupt
    // progress tracking.
    const seen = new Set<string>();
    definition.phases.forEach((phase, index) => {
      if (seen.has(phase.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate phase id "${phase.id}" — phase ids must be unique`,
          path: ['phases', index, 'id'],
        });
      }
      seen.add(phase.id);
    });
  })
  .transform(
    (definition): WorkflowDefinition => ({
      ...definition,
      supportedAutonomyLevels: definition.supportedAutonomyLevels ?? [...ALL_AUTONOMY_LEVELS],
    }),
  );

/** Approval guidance values used by methodology approval maps. */
export const methodologyApprovalValueSchema = z.enum([
  'required',
  'optional',
  'recommended',
  'none',
]);
export type MethodologyApprovalValue = z.infer<typeof methodologyApprovalValueSchema>;

export const methodologyRiskProfileSchema = z.enum(['low', 'medium', 'high']);
export type MethodologyRiskProfile = z.infer<typeof methodologyRiskProfileSchema>;

export interface MethodologyQuestion {
  id: string;
  text: string;
}

export interface Methodology {
  id: string;
  /** Optional discriminator used by declarative extension files. */
  type?: 'methodology';
  name: string;
  description: string;
  /** Defaults to 'delivery'. Discovery uses 'pre_work'. */
  category?: string;
  recommendedAutonomyLevels?: AutonomyLevel[];
  useWhen?: string[];
  avoidWhen?: string[];
  defaultWorkflow?: string;
  workflows?: string[];
  /** Conceptual phase names (not executable phases). */
  phases?: string[];
  artifacts?: string[];
  outputs?: string[];
  modes?: string[];
  questions?: MethodologyQuestion[];
  agentRoles?: AgentRole[];
  roles?: string[];
  approval?: Record<string, MethodologyApprovalValue>;
  /** Defaults to 'medium'. */
  riskProfile?: MethodologyRiskProfile;
  scoring?: unknown;
}

const methodologyObjectSchema = z.object({
  id: z.string().min(1, 'methodology id must be a non-empty string'),
  type: z.literal('methodology').optional(),
  name: z.string().min(1, 'methodology name must be a non-empty string'),
  description: z.string().min(1, 'methodology description must be a non-empty string'),
  category: z.string().min(1).optional(),
  recommendedAutonomyLevels: z.array(autonomyLevelSchema).optional(),
  useWhen: z.array(z.string().min(1)).optional(),
  avoidWhen: z.array(z.string().min(1)).optional(),
  defaultWorkflow: z.string().min(1).optional(),
  workflows: z.array(z.string().min(1)).optional(),
  phases: z.array(z.string().min(1)).optional(),
  artifacts: z.array(z.string().min(1)).optional(),
  outputs: z.array(z.string().min(1)).optional(),
  modes: z.array(z.string().min(1)).optional(),
  questions: z
    .array(
      z.object({
        id: z.string().min(1, 'question id must be a non-empty string'),
        text: z.string().min(1, 'question text must be a non-empty string'),
      }),
    )
    .optional(),
  agentRoles: z.array(agentRoleSchema).optional(),
  roles: z.array(z.string().min(1)).optional(),
  approval: z.record(methodologyApprovalValueSchema).optional(),
  riskProfile: methodologyRiskProfileSchema.optional(),
  scoring: z.unknown().optional(),
});

/**
 * Schema for a methodology definition. Relaxed per the Build Contract:
 * `type`, `category`, `defaultWorkflow` and `riskProfile` are optional, with
 * `category` defaulting to 'delivery' and `riskProfile` to 'medium'.
 */
export const methodologySchema = methodologyObjectSchema.transform(
  (methodology): Methodology => ({
    ...methodology,
    category: methodology.category ?? 'delivery',
    riskProfile: methodology.riskProfile ?? 'medium',
  }),
);
