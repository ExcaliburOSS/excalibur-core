import { z } from 'zod';
import { autonomyLevelSchema } from './autonomy';
import {
  instructionSourceFormatSchema,
  instructionSourceScopeSchema,
  trustLevelSchema,
} from './instructions';

/**
 * `.excalibur/config.yaml` schema (OSS spec §10 + §14, work-items spec §6,
 * onboarding spec §2, ISD spec §6). Every section is optional: a repository
 * without `.excalibur/` must still work on defaults.
 */

/** Canonical detected commands (test/lint/typecheck/build). */
export const commandsConfigSchema = z.object({
  test: z.string().optional(),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
  build: z.string().optional(),
});
export type CommandsConfig = z.infer<typeof commandsConfigSchema>;

const projectSectionSchema = z.object({
  name: z.string().optional(),
  packageManager: z.string().optional(),
  languages: z.array(z.string()).optional(),
  frameworks: z.array(z.string()).optional(),
  /** Accepted alias; normalized into the top-level `commands` section. */
  commands: commandsConfigSchema.optional(),
});

const safetySectionSchema = z.object({
  /** Safety preset id; `standard-safe` when unset (see DEFAULT_CONFIG). */
  preset: z.string().optional(),
});

const autonomySectionSchema = z.object({
  default: autonomyLevelSchema.optional(),
  paths: z.record(autonomyLevelSchema).optional(),
  allowFullAgentic: z.array(z.string()).optional(),
});

const workflowsSectionSchema = z.object({
  default: z.string().optional(),
  byTaskType: z.record(z.string()).optional(),
  byPath: z.record(z.string()).optional(),
});

const modelsSectionSchema = z.object({
  default: z.string().optional(),
  byRole: z.record(z.string()).optional(),
  byPath: z.record(z.string()).optional(),
});

const permissionsSectionSchema = z.object({
  tools: z.record(z.union([z.boolean(), z.literal('ask')])).optional(),
  blockedPaths: z.array(z.string()).optional(),
  allowedCommands: z.array(z.string()).optional(),
});

const approvalsSectionSchema = z.object({
  requiredFor: z
    .object({
      paths: z.array(z.string()).optional(),
      commands: z.array(z.string()).optional(),
      phases: z.array(z.string()).optional(),
    })
    .optional(),
});

const contextSectionSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const agentsSectionSchema = z
  .object({ default: z.string().optional() })
  .catchall(z.unknown());

const instructionSourceRefSchema = z.object({
  path: z.string().min(1),
  format: instructionSourceFormatSchema.optional(),
  scope: instructionSourceScopeSchema.optional(),
  enabled: z.boolean().optional(),
  /** User-global sources are referenced locally only, never synced/copied. */
  localOnly: z.boolean().optional(),
});

const skillSourceRefSchema = z.object({
  path: z.string().min(1),
  scope: z.enum(['project', 'user_global']).optional(),
  enabled: z.boolean().optional(),
  trustLevel: trustLevelSchema.optional(),
});

const baseExcaliburConfigSchema = z.object({
  version: z.number().int().optional(),
  project: projectSectionSchema.optional(),
  /** Top-level canonical commands; `project.commands` is normalized into it. */
  commands: commandsConfigSchema.optional(),
  safety: safetySectionSchema.optional(),
  workflowDefaults: z.record(z.string()).optional(),
  autonomyDefaults: z.record(autonomyLevelSchema).optional(),
  autonomy: autonomySectionSchema.optional(),
  workflows: workflowsSectionSchema.optional(),
  models: modelsSectionSchema.optional(),
  permissions: permissionsSectionSchema.optional(),
  approvals: approvalsSectionSchema.optional(),
  context: contextSectionSchema.optional(),
  integrations: z.record(z.record(z.string())).optional(),
  agents: agentsSectionSchema.optional(),
  instructions: z
    .object({ sources: z.array(instructionSourceRefSchema).optional() })
    .optional(),
  skills: z
    .object({ sources: z.array(skillSourceRefSchema).optional() })
    .optional(),
});

/**
 * Parsing normalizes the `project.commands` alias into the canonical
 * top-level `commands` section. On per-key conflicts the top-level value wins.
 */
export const excaliburConfigSchema = baseExcaliburConfigSchema.transform((config) => {
  const projectCommands = config.project?.commands;
  if (!projectCommands) {
    return config;
  }
  return { ...config, commands: { ...projectCommands, ...config.commands } };
});
export type ExcaliburConfig = z.infer<typeof excaliburConfigSchema>;

/** OSS spec §17 default blocked paths (minimatch patterns, `dot: true`). */
export const DEFAULT_BLOCKED_PATHS: ReadonlyArray<string> = [
  '.env',
  '.env.*',
  '**/*.pem',
  '**/*.key',
  '**/secrets/**',
  '**/.ssh/**',
  'node_modules/**',
  'dist/**',
  'build/**',
];

/** OSS spec §17 default allowed commands (common package-script invocations). */
export const DEFAULT_ALLOWED_COMMANDS: ReadonlyArray<string> = [
  'npm test',
  'npm run test',
  'npm run typecheck',
  'npm run lint',
  'pnpm test',
  'pnpm typecheck',
  'pnpm lint',
  'yarn test',
];

/**
 * Baseline configuration used when `.excalibur/config.yaml` is missing and as
 * the merge base in `loadExcaliburConfig`. Mirrors onboarding spec §2:
 * `standard-safe` preset, command→workflow/autonomy defaults, conservative
 * tool permissions (read-only tools allowed, mutating tools ask, network off).
 */
export const DEFAULT_CONFIG: ExcaliburConfig = {
  version: 1,
  commands: {},
  safety: { preset: 'standard-safe' },
  workflowDefaults: {
    ask: 'ask-repo',
    review: 'review-only',
    patch: 'propose-patch',
    run: 'standard-feature',
    careful: 'structured-feature',
    discovery: 'discovery',
  },
  autonomyDefaults: {
    ask: 1,
    review: 0,
    patch: 2,
    run: 3,
    careful: 4,
    discovery: 0,
  },
  workflows: {
    default: 'standard-feature',
    byTaskType: {
      bugfix: 'fast-fix',
      feature: 'standard-feature',
      refactor: 'safe-refactor',
      migration: 'migration',
      security: 'security-review',
    },
  },
  models: { default: 'mock' },
  agents: { default: 'native' },
  permissions: {
    tools: {
      read_file: true,
      list_files: true,
      search_code: true,
      git_diff: true,
      write_file: 'ask',
      apply_patch: 'ask',
      run_command: 'ask',
      create_branch: 'ask',
      run_tests: 'ask',
      network: false,
    },
    blockedPaths: [...DEFAULT_BLOCKED_PATHS],
    allowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
  },
  instructions: { sources: [] },
  skills: { sources: [] },
};
