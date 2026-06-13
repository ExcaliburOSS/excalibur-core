import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigValidationError } from '@excalibur/shared';
import { formatValidationIssues } from '@excalibur/workflow-schema';

/**
 * Extension manifest (`excalibur.extension.yaml`) — extensions spec §3.
 *
 * Every extension (declarative pack, programmatic, or mixed) is described by
 * a manifest. Declarative contributions reference YAML/Markdown files
 * relative to the extension directory; programmatic contributions name the
 * runtime values the compiled entrypoint provides via the Extension SDK.
 */

/** The three extension kinds (spec §3). */
export const EXTENSION_KINDS = ['declarative', 'programmatic', 'mixed'] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

const fileList = z.array(z.string().min(1));
const nameList = z.array(z.string().min(1));

/**
 * `contributes` keys (spec §3). Declarative keys hold file paths relative to
 * the extension directory; programmatic keys hold contribution names that the
 * entrypoint registers at runtime. `vcsProviders` / `enterpriseSyncProviders`
 * are accepted for forward compatibility with the two remaining programmatic
 * contribution kinds (activated in later milestones).
 */
export const extensionContributionsSchema = z.object({
  methodologies: fileList.optional(),
  workflows: fileList.optional(),
  questionPacks: fileList.optional(),
  promptTemplates: fileList.optional(),
  artifactTemplates: fileList.optional(),
  policyPresets: fileList.optional(),
  modelRouting: fileList.optional(),
  reportTemplates: fileList.optional(),
  roleDefinitions: fileList.optional(),
  commandMappings: fileList.optional(),
  workItemProviders: nameList.optional(),
  communicationProviders: nameList.optional(),
  modelProviders: nameList.optional(),
  agentAdapters: nameList.optional(),
  tools: nameList.optional(),
  contextSources: nameList.optional(),
  exporters: nameList.optional(),
  policyEvaluators: nameList.optional(),
  communicationHandlers: nameList.optional(),
  vcsProviders: nameList.optional(),
  enterpriseSyncProviders: nameList.optional(),
});
export type ExtensionContributions = z.infer<typeof extensionContributionsSchema>;

/** The 10 permission categories (spec §8). */
export const PERMISSION_CATEGORIES = [
  'network',
  'filesystem',
  'process',
  'secrets',
  'git',
  'work_items',
  'communication',
  'models',
  'tools',
  'context',
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/**
 * Permission declarations (spec §8). Categories with a pinned shape get a
 * typed schema; the others are open records (their shapes land with
 * enforcement in M5). The object passes unknown categories through so that
 * `validatePermissions` can warn about them instead of silently dropping.
 */
export const extensionPermissionsSchema = z
  .object({
    network: z.object({ allowedHosts: z.array(z.string()).optional() }).optional(),
    filesystem: z
      .object({
        read: z.array(z.string()).optional(),
        write: z.array(z.string()).optional(),
      })
      .optional(),
    process: z.object({ allowedCommands: z.array(z.string()).optional() }).optional(),
    secrets: z.object({ env: z.array(z.string()).optional() }).optional(),
    git: z.record(z.unknown()).optional(),
    work_items: z.record(z.unknown()).optional(),
    communication: z.record(z.unknown()).optional(),
    models: z.record(z.unknown()).optional(),
    tools: z.record(z.unknown()).optional(),
    context: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type ExtensionPermissions = z.infer<typeof extensionPermissionsSchema>;

/** One `configSchema` entry: `{ type: string; required?: boolean }`. */
export const extensionConfigFieldSchema = z.object({
  type: z.string().min(1),
  required: z.boolean().optional(),
});
export type ExtensionConfigField = z.infer<typeof extensionConfigFieldSchema>;

const EXTENSION_ID_PATTERN = /^[a-z0-9@][a-z0-9@/._-]*$/i;

/** Manifest schema for `excalibur.extension.yaml` (spec §3). */
export const extensionManifestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        EXTENSION_ID_PATTERN,
        'id must start with a letter, digit or "@" and contain only letters, digits and "@/._-"',
      ),
    name: z.string().min(1),
    version: z.string().min(1),
    kind: z.enum(EXTENSION_KINDS),
    description: z.string().optional(),
    entrypoint: z.string().min(1).optional(),
    contributes: extensionContributionsSchema.optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    configSchema: z.record(extensionConfigFieldSchema).optional(),
    permissions: extensionPermissionsSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const needsEntrypoint = manifest.kind === 'programmatic' || manifest.kind === 'mixed';
    if (needsEntrypoint && manifest.entrypoint === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entrypoint'],
        message: `${manifest.kind} extensions must declare an entrypoint (compiled JS, e.g. dist/index.js)`,
      });
    }
    if (manifest.kind === 'declarative' && manifest.entrypoint !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entrypoint'],
        message:
          'declarative extensions must not declare an entrypoint — use kind "programmatic" or "mixed" for code',
      });
    }
  });
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

/** Result shape of `validateManifest`. */
export interface ManifestValidationResult {
  success: boolean;
  data?: ExtensionManifest;
  errors?: string[];
}

/** Validate an unknown value as an extension manifest with readable errors. */
export function validateManifest(value: unknown): ManifestValidationResult {
  const result = extensionManifestSchema.safeParse(value);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, errors: formatValidationIssues(result.error) };
}

/**
 * Load and validate an `excalibur.extension.yaml` manifest from disk.
 * Throws `ConfigValidationError` when the file is missing, is not valid YAML,
 * or fails manifest validation.
 */
export function loadManifest(filePath: string): ExtensionManifest {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(`Cannot read extension manifest ${filePath}: ${reason}`, {
      filePath,
    });
  }
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(
      `Extension manifest ${filePath} is not valid YAML: ${reason}`,
      { filePath },
    );
  }
  const result = validateManifest(value);
  if (!result.success || result.data === undefined) {
    const errors = result.errors ?? ['unknown validation error'];
    throw new ConfigValidationError(
      `Invalid extension manifest ${filePath}:\n- ${errors.join('\n- ')}`,
      { filePath, errors },
    );
  }
  return result.data;
}
