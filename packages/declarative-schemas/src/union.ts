import { z } from 'zod';
import {
  methodologySchema,
  workflowDefinitionSchema,
  type Methodology,
  type WorkflowDefinition,
} from '@excalibur/workflow-schema';
import { DECLARATIVE_TYPES, isDeclarativeType, type DeclarativeType } from './types';
import {
  artifactTemplateSchema,
  commandMappingSchema,
  modelRoutingSchema,
  policyPresetSchema,
  promptTemplateSchema,
  questionPackSchema,
  reportTemplateSchema,
  roleDefinitionSchema,
  type ArtifactTemplateDefinition,
  type CommandMappingDefinition,
  type ModelRoutingDefinition,
  type PolicyPresetDefinition,
  type PromptTemplateDefinition,
  type QuestionPackDefinition,
  type ReportTemplateDefinition,
  type RoleDefinition,
} from './schemas';

/** Map from declarative type name to its parsed definition type. */
export interface DeclarativeDefinitionByType {
  methodology: Methodology;
  workflow: WorkflowDefinition;
  question_pack: QuestionPackDefinition;
  prompt_template: PromptTemplateDefinition;
  artifact_template: ArtifactTemplateDefinition;
  policy_preset: PolicyPresetDefinition;
  model_routing: ModelRoutingDefinition;
  report_template: ReportTemplateDefinition;
  role_definition: RoleDefinition;
  command_mapping: CommandMappingDefinition;
}

/** Any parsed declarative definition (union of all 10 types). */
export type DeclarativeDefinition = DeclarativeDefinitionByType[DeclarativeType];

/** Per-type schema lookup used by the union and by `parseDeclarativeYaml`. */
export const declarativeSchemasByType: Readonly<Record<DeclarativeType, z.ZodTypeAny>> = {
  methodology: methodologySchema,
  workflow: workflowDefinitionSchema,
  question_pack: questionPackSchema,
  prompt_template: promptTemplateSchema,
  artifact_template: artifactTemplateSchema,
  policy_preset: policyPresetSchema,
  model_routing: modelRoutingSchema,
  report_template: reportTemplateSchema,
  role_definition: roleDefinitionSchema,
  command_mapping: commandMappingSchema,
};

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

/**
 * Discriminated union over the 10 declarative types, keyed on `type`.
 *
 * Implemented as a manual dispatch (rather than `z.discriminatedUnion`)
 * because several member schemas use transforms (`workflow`, `methodology`,
 * `artifact_template`), which zod 3 discriminated unions cannot host. The
 * behavior is identical: the `type` field selects exactly one member schema
 * and only that member's issues are reported.
 */
export const declarativeDefinitionSchema: z.ZodType<DeclarativeDefinition, z.ZodTypeDef, unknown> =
  z.unknown().transform((value, ctx): DeclarativeDefinition => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a declarative definition object, got ${describeValue(value)}`,
      });
      return z.NEVER;
    }
    const declaredType = (value as Record<string, unknown>).type;
    if (declaredType === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: `missing "type" — declarative definitions must declare one of: ${DECLARATIVE_TYPES.join(', ')}`,
      });
      return z.NEVER;
    }
    if (!isDeclarativeType(declaredType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['type'],
        message: `unknown declarative type ${JSON.stringify(declaredType)} — expected one of: ${DECLARATIVE_TYPES.join(', ')}`,
      });
      return z.NEVER;
    }
    const result = declarativeSchemasByType[declaredType].safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue(issue);
      }
      return z.NEVER;
    }
    return result.data as DeclarativeDefinition;
  });
