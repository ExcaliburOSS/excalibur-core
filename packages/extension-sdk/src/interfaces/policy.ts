import { z } from 'zod';
import { policyDecisionSchema } from '@excalibur/shared';
import type { AutonomyLevel, PolicyDecisionValue } from '@excalibur/shared';

/**
 * Programmatic policy evaluator contract (extensions-spec.md §5).
 *
 * Evaluators complement declarative `policy_preset` rules when a decision
 * needs runtime logic (call an internal service, inspect file contents, …).
 * The decision value reuses the frozen `policyDecisionSchema` from
 * `@excalibur/shared`: `allow | deny | redact | require_approval`.
 */

/** The action under evaluation, mirroring declarative `policy_preset` rules. */
export interface PolicyContext {
  /** Action identifier (e.g. `file_write`, `command_run`, `tool_call`). */
  action: string;
  /** Repo-relative path when the action targets a file. */
  filePath?: string;
  /** Full command line when the action runs a command. */
  command?: string;
  /** Tool name when the action is a tool invocation. */
  toolName?: string;
  /** Autonomy level of the surrounding run/interaction. */
  autonomyLevel?: AutonomyLevel;
  /** Local run id when the action happens inside a run. */
  runId?: string;
  metadata?: Record<string, unknown>;
}

/** Zod schema for a full policy decision (value + optional reason). */
export const policyDecisionResultSchema = z.object({
  decision: policyDecisionSchema,
  reason: z.string().optional(),
});

/** Decision returned by an evaluator. */
export interface PolicyDecision {
  decision: PolicyDecisionValue;
  /** Human-readable explanation, surfaced in approvals and audit trails. */
  reason?: string;
}

export interface PolicyEvaluator {
  /** Stable evaluator id (e.g. `pii-guard`). */
  id: string;
  evaluate(context: PolicyContext): Promise<PolicyDecision>;
}
