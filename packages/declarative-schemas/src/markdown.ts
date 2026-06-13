import { parse as parseYamlText } from 'yaml';
import { WorkflowValidationError } from '@excalibur/shared';
import { formatValidationIssues } from '@excalibur/workflow-schema';
import {
  artifactTemplateSchema,
  promptTemplateSchema,
  type ArtifactTemplateDefinition,
  type PromptTemplateDefinition,
} from './schemas';

/**
 * Markdown declarative files (extensions spec §4): a Markdown file becomes a
 * `prompt_template` or an `artifact_template`. The target type comes from
 * front-matter `type` (explicit author intent wins) or from the directory
 * the file lives in (`prompts/` vs `artifacts/`); the id from front-matter
 * `id` or the filename.
 */

/** The two declarative types a Markdown file can define. */
export type MarkdownDeclarativeType = 'prompt_template' | 'artifact_template';

/** Result of `parseDeclarativeMarkdown`. */
export type MarkdownDeclarativeDefinition =
  | PromptTemplateDefinition
  | ArtifactTemplateDefinition;

const MARKDOWN_TYPES: readonly MarkdownDeclarativeType[] = [
  'prompt_template',
  'artifact_template',
];

/** Directory names that imply a Markdown declarative type (`.excalibur/` layout). */
const DIRECTORY_HINTS: Readonly<Record<string, MarkdownDeclarativeType>> = {
  prompts: 'prompt_template',
  'prompt-templates': 'prompt_template',
  artifacts: 'artifact_template',
  'artifact-templates': 'artifact_template',
};

// `m` flag so the closing delimiter anchors at a line start, which also
// matches a completely empty front-matter block (`---\n---`).
const FRONT_MATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;
const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown)$/i;

interface SplitContent {
  frontMatter: Record<string, unknown>;
  body: string;
}

function splitFrontMatter(filePath: string, content: string): SplitContent {
  const match = FRONT_MATTER_PATTERN.exec(content);
  if (match === null) {
    return { frontMatter: {}, body: content };
  }
  const body = content.slice(match[0].length);
  let value: unknown;
  try {
    value = parseYamlText(match[1] ?? '');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkflowValidationError(
      `Invalid front matter in ${filePath}: ${reason}`,
      { filePath, reason },
    );
  }
  if (value === null || value === undefined) {
    return { frontMatter: {}, body };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkflowValidationError(
      `Invalid front matter in ${filePath}: expected a YAML mapping.`,
      { filePath },
    );
  }
  return { frontMatter: value as Record<string, unknown>, body };
}

/** Platform-independent path segmentation (handles both `/` and `\`). */
function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/** The directory closest to the file wins when multiple hints are present. */
function directoryHint(segments: string[]): MarkdownDeclarativeType | undefined {
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const hint = DIRECTORY_HINTS[segment.toLowerCase()];
    if (hint !== undefined) return hint;
  }
  return undefined;
}

function resolveTargetType(
  filePath: string,
  frontMatter: Record<string, unknown>,
  segments: string[],
): MarkdownDeclarativeType {
  const declaredType = frontMatter.type;
  if (declaredType !== undefined) {
    if (
      typeof declaredType === 'string' &&
      (MARKDOWN_TYPES as readonly string[]).includes(declaredType)
    ) {
      return declaredType as MarkdownDeclarativeType;
    }
    throw new WorkflowValidationError(
      `Invalid declarative Markdown file ${filePath}: front-matter type ${JSON.stringify(declaredType)} is not supported — Markdown files can only define ${MARKDOWN_TYPES.join(' or ')}; use a YAML file for other declarative types.`,
      { filePath, declaredType },
    );
  }
  const hint = directoryHint(segments);
  if (hint === undefined) {
    throw new WorkflowValidationError(
      `Cannot determine the declarative type of ${filePath}: place the file under a prompts/ or artifacts/ directory, or add front matter declaring "type: prompt_template" or "type: artifact_template".`,
      { filePath },
    );
  }
  return hint;
}

/** `refined-ticket` → `Refined Ticket`. */
function humanizeIdentifier(stem: string): string {
  const words = stem.split(/[-_\s]+/).filter((word) => word.length > 0);
  if (words.length === 0) return stem;
  return words
    .map((word) => (word[0]?.toUpperCase() ?? '') + word.slice(1))
    .join(' ');
}

/**
 * Parse a Markdown declarative file into a `prompt_template` or
 * `artifact_template` definition.
 *
 * Resolution rules:
 * - type: front-matter `type` (must be one of the two Markdown types),
 *   else directory hint (`prompts/` → prompt_template, `artifacts/` →
 *   artifact_template; closest directory wins), else a readable error.
 * - id: front-matter `id`, else the filename without its extension.
 * - name: front-matter `name`, else humanized from the id stem.
 * - template: the Markdown body below the front matter (trimmed); for
 *   artifact templates, `variables` are auto-extracted from `{{...}}`.
 *
 * Throws `WorkflowValidationError` with the file path in the message on any
 * failure (bad front matter, unsupported type, empty body, schema issues).
 */
export function parseDeclarativeMarkdown(
  filePath: string,
  content: string,
): MarkdownDeclarativeDefinition {
  const segments = pathSegments(filePath);
  const { frontMatter, body } = splitFrontMatter(filePath, content);
  const targetType = resolveTargetType(filePath, frontMatter, segments);

  const fileName = segments[segments.length - 1] ?? '';
  const stem = fileName.replace(MARKDOWN_EXTENSION_PATTERN, '');

  const candidate: Record<string, unknown> = {
    ...frontMatter,
    id: frontMatter.id ?? stem,
    name: frontMatter.name ?? humanizeIdentifier(stem),
    type: targetType,
    template: body.trim(),
  };

  const schema =
    targetType === 'prompt_template' ? promptTemplateSchema : artifactTemplateSchema;
  const result = schema.safeParse(candidate);
  if (!result.success) {
    const issues = formatValidationIssues(result.error);
    const lines = issues.map((issue) => `  - ${issue}`).join('\n');
    throw new WorkflowValidationError(
      `Invalid ${targetType} ${filePath}:\n${lines}`,
      { filePath, issues },
    );
  }
  return result.data;
}
