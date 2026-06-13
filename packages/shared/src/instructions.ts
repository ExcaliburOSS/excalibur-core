import { z } from 'zod';

/**
 * Instruction and Skill Discovery (ISD) shared types
 * (docs/spec/instructions-skills-core.md §2–§3).
 *
 * Excalibur detects the AI instruction files and skill definitions teams
 * already maintain (CLAUDE.md, AGENTS.md, Cursor rules, SKILL.md, …),
 * classifies them and assigns conservative trust defaults. The scanner lives
 * in `@excalibur/context-engine`; the types and the trust-default table live
 * here so Core and Enterprise share the exact same classification contract.
 */

export const instructionSourceScopeSchema = z.enum([
  'project',
  'workspace',
  'user_global',
  'enterprise',
]);
export type InstructionSourceScope = z.infer<typeof instructionSourceScopeSchema>;

export const instructionSourceFormatSchema = z.enum([
  'claude_md',
  'skill_md',
  'agents_md',
  'cursor_rules',
  'copilot_instructions',
  'gemini_md',
  'codex',
  'aider',
  'docs',
  'adr',
  'custom',
]);
export type InstructionSourceFormat = z.infer<typeof instructionSourceFormatSchema>;

export const instructionSourceKindSchema = z.enum([
  'instruction',
  'skill',
  'context',
  'policy_hint',
  'workflow_hint',
]);
export type InstructionSourceKind = z.infer<typeof instructionSourceKindSchema>;

export const trustLevelSchema = z.enum(['trusted', 'review_required', 'untrusted']);
export type TrustLevel = z.infer<typeof trustLevelSchema>;

export const instructionSourceSchema = z.object({
  id: z.string().min(1),
  scope: instructionSourceScopeSchema,
  format: instructionSourceFormatSchema,
  kind: instructionSourceKindSchema,
  path: z.string().min(1),
  title: z.string().nullable(),
  /** sha256 hex digest of the source content. */
  contentHash: z.string().min(1),
  trustLevel: trustLevelSchema,
  enabled: z.boolean(),
  importedAs: instructionSourceKindSchema,
  metadata: z.record(z.unknown()),
});
export type InstructionSource = z.infer<typeof instructionSourceSchema>;

export const detectedSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  path: z.string().min(1),
  scope: z.enum(['project', 'user_global']),
  description: z.string().nullable(),
  triggers: z.array(z.string()),
  dependencies: z.array(z.string()),
  toolsRequired: z.array(z.string()),
  trustLevel: trustLevelSchema,
  enabled: z.boolean(),
  source: instructionSourceSchema,
});
export type DetectedSkill = z.infer<typeof detectedSkillSchema>;

export interface DefaultTrustRule {
  format: InstructionSourceFormat;
  scope: InstructionSourceScope;
  trustLevel: TrustLevel;
  kind: InstructionSourceKind;
}

/**
 * Trust-default table (ISD spec §3) as data.
 *
 * - Project instruction files maintained in the repo are `trusted`.
 * - Project docs/ADRs are `trusted` but classified as `context`.
 * - The user-global CLAUDE.md is `trusted` for local user context only
 *   (it is never copied into the repo without explicit confirmation).
 * - SKILL.md files are capability definitions: always `review_required`
 *   and never auto-enabled, regardless of scope.
 * - Unknown/custom formats default to `review_required`.
 */
export const DEFAULT_TRUST_RULES: DefaultTrustRule[] = [
  { format: 'claude_md', scope: 'project', trustLevel: 'trusted', kind: 'instruction' },
  { format: 'agents_md', scope: 'project', trustLevel: 'trusted', kind: 'instruction' },
  { format: 'cursor_rules', scope: 'project', trustLevel: 'trusted', kind: 'instruction' },
  { format: 'copilot_instructions', scope: 'project', trustLevel: 'trusted', kind: 'instruction' },
  { format: 'gemini_md', scope: 'project', trustLevel: 'trusted', kind: 'instruction' },
  { format: 'codex', scope: 'project', trustLevel: 'trusted', kind: 'instruction' },
  { format: 'aider', scope: 'project', trustLevel: 'trusted', kind: 'instruction' },
  { format: 'docs', scope: 'project', trustLevel: 'trusted', kind: 'context' },
  { format: 'adr', scope: 'project', trustLevel: 'trusted', kind: 'context' },
  { format: 'claude_md', scope: 'user_global', trustLevel: 'trusted', kind: 'instruction' },
  { format: 'skill_md', scope: 'project', trustLevel: 'review_required', kind: 'skill' },
  { format: 'skill_md', scope: 'user_global', trustLevel: 'review_required', kind: 'skill' },
  { format: 'custom', scope: 'project', trustLevel: 'review_required', kind: 'instruction' },
];

/**
 * Looks up the default trust classification for a format/scope pair.
 * Falls back to the conservative default when no explicit rule exists:
 * `review_required`, kind `skill` for skill_md and `instruction` otherwise.
 */
export function resolveDefaultTrust(
  format: InstructionSourceFormat,
  scope: InstructionSourceScope,
): { trustLevel: TrustLevel; kind: InstructionSourceKind } {
  const rule = DEFAULT_TRUST_RULES.find((r) => r.format === format && r.scope === scope);
  if (rule) {
    return { trustLevel: rule.trustLevel, kind: rule.kind };
  }
  return {
    trustLevel: 'review_required',
    kind: format === 'skill_md' ? 'skill' : 'instruction',
  };
}
