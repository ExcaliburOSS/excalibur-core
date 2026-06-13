import { parse as parseYamlText } from 'yaml';
import { WorkflowValidationError } from '@excalibur/shared';
import { formatValidationIssues } from '@excalibur/workflow-schema';
import type { z } from 'zod';
import { isDeclarativeType, type DeclarativeType } from './types';
import {
  declarativeDefinitionSchema,
  declarativeSchemasByType,
  type DeclarativeDefinition,
  type DeclarativeDefinitionByType,
} from './union';

/**
 * YAML parsing for declarative extension files. All failures throw
 * `WorkflowValidationError` (the definition-validation error of the
 * Excalibur hierarchy) with human-readable messages naming the offending
 * path and the problem — consistent with `parseWorkflowYaml`.
 */

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

function typeLabel(declarativeType: DeclarativeType | undefined): string {
  return declarativeType === undefined
    ? 'declarative definition'
    : `${declarativeType} definition`;
}

function definitionLabel(
  value: Record<string, unknown>,
  declarativeType: DeclarativeType | undefined,
): string {
  const label = typeLabel(declarativeType);
  const id = value.id;
  if (typeof id === 'string' && id.length > 0) return `${label} "${id}"`;
  return label;
}

function parseYamlMapping(
  yamlText: string,
  declarativeType: DeclarativeType | undefined,
): Record<string, unknown> {
  const label = typeLabel(declarativeType);
  let value: unknown;
  try {
    value = parseYamlText(yamlText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError(`Invalid ${label} YAML: ${reason}`, { reason });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError(
      `Invalid ${label}: expected a YAML mapping with the definition fields, got ${describeValue(value)}.`,
    );
  }
  return value as Record<string, unknown>;
}

function throwValidationError(
  value: Record<string, unknown>,
  declarativeType: DeclarativeType | undefined,
  error: z.ZodError,
): never {
  const issues = formatValidationIssues(error);
  const lines = issues.map((issue) => `  - ${issue}`).join('\n');
  throw new WorkflowValidationError(
    `Invalid ${definitionLabel(value, declarativeType)}:\n${lines}`,
    { issues },
  );
}

/**
 * Parse and validate a declarative definition from YAML text.
 *
 * Without `expectedType`, the document must carry a `type` field naming one
 * of the 10 declarative types (the discriminated union decides). With
 * `expectedType` (e.g. derived from the `.excalibur/question-packs/`
 * directory the file lives in), a missing `type` field is filled in from the
 * hint, and a conflicting `type` field is a readable error.
 *
 * Throws `WorkflowValidationError` on YAML syntax errors, type mismatches
 * and schema violations.
 */
export function parseDeclarativeYaml<T extends DeclarativeType>(
  yamlText: string,
  expectedType: T,
): DeclarativeDefinitionByType[T];
export function parseDeclarativeYaml(yamlText: string): DeclarativeDefinition;
export function parseDeclarativeYaml(
  yamlText: string,
  expectedType?: DeclarativeType,
): DeclarativeDefinition {
  const value = parseYamlMapping(yamlText, expectedType);

  if (expectedType === undefined) {
    const result = declarativeDefinitionSchema.safeParse(value);
    if (!result.success) {
      const declared = value.type;
      throwValidationError(
        value,
        isDeclarativeType(declared) ? declared : undefined,
        result.error,
      );
    }
    return result.data;
  }

  const declaredType = value.type;
  if (declaredType !== undefined && declaredType !== expectedType) {
    throw new WorkflowValidationError(
      `Invalid ${definitionLabel(value, expectedType)}: declares type ${JSON.stringify(declaredType)} but ${JSON.stringify(expectedType)} was expected here.`,
      { declaredType, expectedType },
    );
  }

  // Directory-style hints let files omit the discriminator.
  const candidate = { ...value, type: expectedType };
  const result = declarativeSchemasByType[expectedType].safeParse(candidate);
  if (!result.success) {
    throwValidationError(value, expectedType, result.error);
  }
  return result.data as DeclarativeDefinition;
}
