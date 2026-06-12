import { z } from 'zod';

/**
 * Domain enums shared across Excalibur Core packages and reused by Excalibur Enterprise.
 * These are contract values: renaming or removing a member is a breaking change for
 * Enterprise ingestion, the CLI and stored artifacts.
 */

export const executionStyleSchema = z.enum([
  'fast',
  'team_default',
  'careful',
  'structured',
  'explore',
  'custom',
]);
export type ExecutionStyle = z.infer<typeof executionStyleSchema>;

export const outputTypeSchema = z.enum([
  'branch',
  'pull_request',
  'patch',
  'review',
  'plan',
  'alternatives',
]);
export type OutputType = z.infer<typeof outputTypeSchema>;

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const phaseStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'skipped',
]);
export type PhaseStatus = z.infer<typeof phaseStatusSchema>;

export const agentRoleSchema = z.enum([
  'planner',
  'architect',
  'implementer',
  'reviewer',
  'tester',
  'security',
  'release',
  'product_strategist',
  'customer_researcher',
  'discovery_reviewer',
  'ux_reviewer',
  'growth_reviewer',
  'scope_guardian',
  'custom',
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const workflowModeSchema = z.enum([
  'fast',
  'standard',
  'structured',
  'explore',
  'review',
  'discovery',
  'custom',
]);
export type WorkflowMode = z.infer<typeof workflowModeSchema>;

/**
 * Workflow phase types. Superset of the Enterprise workflow spec (§8) plus the
 * `apply_patch` phase type introduced by the OSS workflow catalog and the
 * `discovery_questions` phase type introduced by the Discovery methodology.
 */
export const phaseTypeSchema = z.enum([
  'assistant_interaction',
  'patch_generation',
  'agent_output',
  'agent_work',
  'agent_review',
  'command_group',
  'human_approval',
  'pull_request',
  'apply_patch',
  'discovery_questions',
  'custom',
]);
export type PhaseType = z.infer<typeof phaseTypeSchema>;

export const testStatusSchema = z.enum(['not_run', 'passed', 'failed', 'partial']);
export type TestStatus = z.infer<typeof testStatusSchema>;

export const riskLevelSchema = z.enum(['low', 'medium', 'high', 'unknown']);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const policyDecisionSchema = z.enum(['allow', 'deny', 'redact', 'require_approval']);
export type PolicyDecisionValue = z.infer<typeof policyDecisionSchema>;
