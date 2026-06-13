import { ExcaliburError } from '@excalibur/shared';

/**
 * Comment templates rendered with `{{variable}}` placeholders
 * (docs/spec/work-items-core.md §5). Template bodies are verbatim from the
 * spec.
 */

export const COMMENT_TEMPLATE_NAMES = [
  'run_started',
  'plan_generated',
  'patch_suggested',
  'pr_opened',
  'run_failed',
  'need_repository',
  'identity_not_verified',
] as const;
export type CommentTemplateName = (typeof COMMENT_TEMPLATE_NAMES)[number];

export const COMMENT_TEMPLATES: Record<CommentTemplateName, string> = {
  run_started: [
    'Excalibur started an agentic run.',
    '',
    'Task: {{title}}',
    'Repository: {{repository}}',
    'Workflow: {{workflow}}',
    'Autonomy: {{autonomyLevelLabel}}',
    'Execution: {{executionStyle}}',
    '',
    'Run: {{runUrl}}',
  ].join('\n'),
  plan_generated: [
    'Excalibur generated an implementation plan.',
    '',
    '{{planSummary}}',
    '',
    'Run/Interaction: {{url}}',
  ].join('\n'),
  patch_suggested: [
    'Excalibur generated a patch suggestion.',
    '',
    'Files affected:',
    '{{filesAffected}}',
    '',
    'Summary:',
    '{{summary}}',
    '',
    'Patch: {{patchUrl}}',
  ].join('\n'),
  pr_opened: [
    'Excalibur opened a pull request.',
    '',
    'PR: {{pullRequestUrl}}',
    'Run: {{runUrl}}',
    '',
    'Summary:',
    '{{summary}}',
  ].join('\n'),
  run_failed: [
    'Excalibur run failed.',
    '',
    'Reason:',
    '{{reason}}',
    '',
    'Run: {{runUrl}}',
  ].join('\n'),
  need_repository: [
    'Excalibur needs a target repository before it can continue.',
    '',
    'Please use:',
    '@excalibur implement --repo <repository-name>',
  ].join('\n'),
  identity_not_verified:
    'Excalibur could not verify your identity. Please connect your Excalibur account before running this command.',
};

/**
 * Thrown when a comment template cannot be rendered. Default code is
 * `template_missing_variable`; callers may narrow it (e.g.
 * `template_not_found`) through `options.code`.
 */
export class TemplateRenderError extends ExcaliburError {
  constructor(message: string, options?: { code?: string; details?: Record<string, unknown> }) {
    super(message, options?.code ?? 'template_missing_variable', options?.details);
  }
}

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

/**
 * Renders a comment template, replacing every `{{variable}}` placeholder with
 * the corresponding entry in `vars`. Strict: every placeholder must have a
 * value (empty string allowed); otherwise a `TemplateRenderError` with code
 * `template_missing_variable` is thrown listing all missing variables.
 * Extra variables are ignored.
 */
export function renderCommentTemplate(
  name: CommentTemplateName,
  vars: Record<string, string>,
): string {
  const template: string | undefined = COMMENT_TEMPLATES[name];
  if (template === undefined) {
    throw new TemplateRenderError(`Unknown comment template: "${String(name)}".`, {
      code: 'template_not_found',
      details: { template: String(name), knownTemplates: [...COMMENT_TEMPLATE_NAMES] },
    });
  }

  const missing: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const variable = match[1];
    if (variable !== undefined && !(variable in vars) && !missing.includes(variable)) {
      missing.push(variable);
    }
  }
  if (missing.length > 0) {
    throw new TemplateRenderError(
      `Missing variable(s) for comment template "${name}": ${missing.join(', ')}.`,
      { details: { template: name, missing } },
    );
  }

  return template.replace(PLACEHOLDER_PATTERN, (placeholder, variable: string) => {
    const value = vars[variable];
    return value === undefined ? placeholder : value;
  });
}
