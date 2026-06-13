import { parse as parseYamlText } from 'yaml';
import { WorkflowValidationError } from '@excalibur/shared';
import type { z } from 'zod';
import {
  methodologySchema,
  workflowDefinitionSchema,
  type Methodology,
  type WorkflowDefinition,
} from './schema';

/**
 * YAML parsing and validation for workflow/methodology definitions.
 * All failures throw `WorkflowValidationError` with a human-readable message
 * naming the offending path and the problem.
 */

function formatIssuePath(path: ReadonlyArray<string | number | symbol>): string {
  if (path.length === 0) return '(root)';
  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${String(segment)}]`;
    } else {
      formatted += formatted.length === 0 ? String(segment) : `.${String(segment)}`;
    }
  }
  return formatted;
}

/** Render zod issues as `path: problem` lines. */
export function formatValidationIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  return `a ${typeof value}`;
}

function parseYamlDocument(yamlText: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseYamlText(yamlText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError(`Invalid ${what} YAML: ${reason}`, { reason });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError(
      `Invalid ${what}: expected a YAML mapping with the ${what} fields, got ${describeValue(value)}.`,
    );
  }
  return value as Record<string, unknown>;
}

function definitionLabel(value: unknown, what: string): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) return `${what} "${id}"`;
  }
  return what;
}

function throwValidationError(value: unknown, what: string, error: z.ZodError): never {
  const issues = formatValidationIssues(error);
  const lines = issues.map((issue) => `  - ${issue}`).join('\n');
  throw new WorkflowValidationError(`Invalid ${definitionLabel(value, what)}:\n${lines}`, {
    issues,
  });
}

/**
 * Parse and validate a workflow definition from YAML text.
 * Throws `WorkflowValidationError` on YAML syntax errors or schema violations.
 */
export function parseWorkflowYaml(yamlText: string): WorkflowDefinition {
  const value = parseYamlDocument(yamlText, 'workflow definition');
  const result = workflowDefinitionSchema.safeParse(value);
  if (!result.success) {
    throwValidationError(value, 'workflow definition', result.error);
  }
  return result.data;
}

/**
 * Parse and validate a methodology definition from YAML text.
 * Throws `WorkflowValidationError` on YAML syntax errors or schema violations.
 */
export function parseMethodologyYaml(yamlText: string): Methodology {
  const value = parseYamlDocument(yamlText, 'methodology definition');
  const result = methodologySchema.safeParse(value);
  if (!result.success) {
    throwValidationError(value, 'methodology definition', result.error);
  }
  return result.data;
}

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
}

/** Non-throwing validation of an already-parsed workflow definition value. */
export function validateWorkflowDefinition(value: unknown): ValidationResult<WorkflowDefinition> {
  const result = workflowDefinitionSchema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: formatValidationIssues(result.error) };
}

/** Non-throwing validation of an already-parsed methodology value. */
export function validateMethodology(value: unknown): ValidationResult<Methodology> {
  const result = methodologySchema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, errors: formatValidationIssues(result.error) };
}
