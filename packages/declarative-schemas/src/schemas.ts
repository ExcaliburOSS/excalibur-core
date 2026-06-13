import { z } from 'zod';
import { policyDecisionSchema } from '@excalibur/shared';

/**
 * Zod schemas for the eight declarative extension types owned by this
 * package (extensions spec §4). `methodology` and `workflow` stay in
 * `@excalibur/workflow-schema` and are re-exported from the package index.
 *
 * Unknown keys are stripped (zod default), matching the tolerant parsing of
 * workflow/methodology files: teams may annotate their YAML freely.
 */

const definitionIdSchema = z.string().min(1, 'id must be a non-empty string');
const definitionNameSchema = z.string().min(1, 'name must be a non-empty string');

/** `{{variable}}` placeholders: word characters, dots and dashes, optional inner padding. */
const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\}\}/g;

/**
 * Extract the unique `{{...}}` placeholder names from a template body,
 * in order of first appearance. `{{ user }}` and `{{user}}` both yield `user`.
 */
export function extractTemplateVariables(template: string): string[] {
  const variables: string[] = [];
  for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !variables.includes(name)) {
      variables.push(name);
    }
  }
  return variables;
}

/** question_pack: `{ id, type: 'question_pack', name, questions: [{ id, text }] }`. */
export const questionPackQuestionSchema = z.object({
  id: z.string().min(1, 'question id must be a non-empty string'),
  text: z.string().min(1, 'question text must be a non-empty string'),
});
export type QuestionPackQuestion = z.infer<typeof questionPackQuestionSchema>;

export const questionPackSchema = z.object({
  id: definitionIdSchema,
  type: z.literal('question_pack'),
  name: definitionNameSchema,
  description: z.string().optional(),
  questions: z
    .array(questionPackQuestionSchema)
    .min(1, 'a question pack must declare at least one question'),
});
export type QuestionPackDefinition = z.infer<typeof questionPackSchema>;

/**
 * prompt_template: YAML `{ id, type: 'prompt_template', name, template }`,
 * or a Markdown file (id from filename) via `parseDeclarativeMarkdown`.
 */
export const promptTemplateSchema = z.object({
  id: definitionIdSchema,
  type: z.literal('prompt_template'),
  name: definitionNameSchema,
  description: z.string().optional(),
  template: z.string().min(1, 'prompt template body must not be empty'),
});
export type PromptTemplateDefinition = z.infer<typeof promptTemplateSchema>;

/**
 * artifact_template: Markdown with `{{variable}}` placeholders (id from
 * filename or YAML wrapper). `variables` is always auto-extracted from the
 * template body; explicitly declared variables not present in the body are
 * preserved after the extracted ones.
 */
export interface ArtifactTemplateDefinition {
  id: string;
  type: 'artifact_template';
  name?: string;
  description?: string;
  template: string;
  /** Auto-extracted from `{{...}}` placeholders, in order of first appearance. */
  variables: string[];
}

const artifactTemplateObjectSchema = z.object({
  id: definitionIdSchema,
  type: z.literal('artifact_template'),
  name: definitionNameSchema.optional(),
  description: z.string().optional(),
  template: z.string().min(1, 'artifact template body must not be empty'),
  variables: z.array(z.string().min(1)).optional(),
});

export const artifactTemplateSchema = artifactTemplateObjectSchema.transform(
  (definition): ArtifactTemplateDefinition => {
    const extracted = extractTemplateVariables(definition.template);
    const declared = definition.variables ?? [];
    return {
      ...definition,
      variables: [...extracted, ...declared.filter((name) => !extracted.includes(name))],
    };
  },
);

/** Condition block of one policy rule; an empty `when` matches everything. */
export const policyRuleConditionSchema = z.object({
  filePathMatches: z.array(z.string().min(1)).optional(),
  action: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
});
export type PolicyRuleCondition = z.infer<typeof policyRuleConditionSchema>;

/** Decision values reuse `policyDecisionSchema` from `@excalibur/shared`. */
export const policyRuleSchema = z.object({
  id: z.string().min(1, 'policy rule id must be a non-empty string'),
  when: policyRuleConditionSchema,
  decision: policyDecisionSchema,
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

/** policy_preset: `{ id, type: 'policy_preset', rules: [{ id, when, decision }] }`. */
export const policyPresetSchema = z.object({
  id: definitionIdSchema,
  type: z.literal('policy_preset'),
  name: definitionNameSchema.optional(),
  description: z.string().optional(),
  rules: z.array(policyRuleSchema).min(1, 'a policy preset must declare at least one rule'),
});
export type PolicyPresetDefinition = z.infer<typeof policyPresetSchema>;

/** model_routing: `{ id, type: 'model_routing', default?, byRole?, byPath?, byWorkflow? }`. */
export const modelRoutingSchema = z.object({
  id: definitionIdSchema,
  type: z.literal('model_routing'),
  name: definitionNameSchema.optional(),
  description: z.string().optional(),
  default: z.string().min(1).optional(),
  byRole: z.record(z.string().min(1)).optional(),
  byPath: z.record(z.string().min(1)).optional(),
  byWorkflow: z.record(z.string().min(1)).optional(),
});
export type ModelRoutingDefinition = z.infer<typeof modelRoutingSchema>;

/** report_template: `{ id, type: 'report_template', name, sections: string[] }`. */
export const reportTemplateSchema = z.object({
  id: definitionIdSchema,
  type: z.literal('report_template'),
  name: definitionNameSchema,
  description: z.string().optional(),
  sections: z
    .array(z.string().min(1, 'section names must be non-empty strings'))
    .min(1, 'a report template must declare at least one section'),
});
export type ReportTemplateDefinition = z.infer<typeof reportTemplateSchema>;

/** role_definition: `{ id, type: 'role_definition', name, description }`. */
export const roleDefinitionSchema = z.object({
  id: definitionIdSchema,
  type: z.literal('role_definition'),
  name: definitionNameSchema,
  description: z.string().min(1, 'role description must be a non-empty string'),
});
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

/** One command mapping entry: `{ trigger, action, defaults? }`. */
export const commandMappingEntrySchema = z.object({
  trigger: z.string().min(1, 'command trigger must be a non-empty string'),
  action: z.string().min(1, 'command action must be a non-empty string'),
  defaults: z.record(z.unknown()).optional(),
});
export type CommandMappingEntry = z.infer<typeof commandMappingEntrySchema>;

/** command_mapping: `{ id, type: 'command_mapping', commands: [{ trigger, action, defaults? }] }`. */
export const commandMappingSchema = z.object({
  id: definitionIdSchema,
  type: z.literal('command_mapping'),
  name: definitionNameSchema.optional(),
  description: z.string().optional(),
  commands: z
    .array(commandMappingEntrySchema)
    .min(1, 'a command mapping must declare at least one command'),
});
export type CommandMappingDefinition = z.infer<typeof commandMappingSchema>;
