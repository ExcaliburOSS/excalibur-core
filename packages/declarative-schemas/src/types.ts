/**
 * The 10 declarative extension types (extensions spec §1 and §4).
 *
 * Declarative extensions are YAML/Markdown files with no code: safe,
 * portable, Git-versionable and editable by tech leads. `methodology` and
 * `workflow` remain owned by `@excalibur/workflow-schema`; this package owns
 * the schemas for the other eight and the discriminated union over all ten.
 */
export const DECLARATIVE_TYPES = [
  'methodology',
  'workflow',
  'question_pack',
  'prompt_template',
  'artifact_template',
  'policy_preset',
  'model_routing',
  'report_template',
  'role_definition',
  'command_mapping',
] as const;

/** One of the 10 declarative extension type names. */
export type DeclarativeType = (typeof DECLARATIVE_TYPES)[number];

/** Narrowing helper for unknown `type` values read from YAML/front matter. */
export function isDeclarativeType(value: unknown): value is DeclarativeType {
  return (
    typeof value === 'string' && (DECLARATIVE_TYPES as readonly string[]).includes(value)
  );
}
