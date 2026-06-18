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
  /**
   * Session auto-accept preference (minimum-friction mode). When `true`, the
   * interactive shell never prompts for edit/command approval (blocked paths
   * stay hard-denied). `undefined` = not chosen yet → the shell asks ONCE at
   * session start and persists the answer here, so it never asks again.
   */
  auto: z.boolean().optional(),
});

const contextSectionSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const agentsSectionSchema = z.object({ default: z.string().optional() }).catchall(z.unknown());

/**
 * `compaction:` — context compaction knobs (plan §"Compactación de contexto").
 * Automatic + config-only (no plugin SDK). Field-tested defaults; each field
 * defaults independently so a partial block is valid. The core compaction engine
 * (`@excalibur/core`) consumes this exact shape.
 */
export const compactionConfigSchema = z.object({
  /** Master switch (default true; disable with one flag). */
  enabled: z.boolean().default(true),
  /** Tokens held back from the window for the reply + headroom. */
  reserveTokens: z.number().int().positive().default(16384),
  /** Tokens of the recent tail preserved verbatim (cut only at turn limits). */
  keepRecentTokens: z.number().int().positive().default(20000),
  /**
   * Which model summarizes: `active` (the main session model — the DEFAULT,
   * since the summary becomes durable context so quality matters most), `cheap`
   * (opt-in: the fast pairing model for lower cost/latency), or a concrete id.
   */
  summarizerModel: z.string().min(1).default('active'),
  /** Prune stale tool outputs before summarizing. */
  pruneToolOutputs: z.boolean().default(true),
});
export type CompactionConfig = z.infer<typeof compactionConfigSchema>;

/** Default compaction config when `.excalibur/config.yaml` has no `compaction:` block. */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  summarizerModel: 'active',
  pruneToolOutputs: true,
};

/**
 * `mcp:` — Model Context Protocol servers whose tools the agent may call. Each
 * is EITHER a local subprocess (`command` + args, NO shell) OR a remote server
 * (`url`, Streamable HTTP, with optional auth `headers`). Absent → MCP off.
 * API keys/secrets belong in the process environment (inherited by a local
 * server), NOT in this file; `env` is for non-secret overrides only. For a
 * remote server, prefer an env-var reference in `headers` over a literal secret.
 */
const mcpServerConfigSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    /** Remote MCP endpoint (Streamable HTTP). Set this OR `command`. */
    url: z.string().url().optional(),
    /** Headers sent on every remote request, e.g. `{ Authorization: "Bearer …" }`. */
    headers: z.record(z.string()).optional(),
  })
  .refine((s) => s.command !== undefined || s.url !== undefined, {
    message: 'an MCP server needs a `command` (local stdio) or a `url` (remote http)',
  });
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpSectionSchema = z.object({
  servers: z.record(mcpServerConfigSchema).optional(),
});

/**
 * `sandbox:` — run agent shell commands inside an ephemeral Docker container
 * (OSS spec §18, M3). Off by default. When `enabled`, `run_command` executes in
 * an isolated container (only the repo mounted, no host secrets/network) instead
 * of on the host. `image` must carry the repo's toolchain (default Alpine has no
 * node/pnpm), so this is an advanced opt-in.
 */
export const sandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Container image (must have `sh` + the repo's toolchain). */
  image: z.string().min(1).optional(),
  memoryMb: z.number().int().positive().optional(),
  cpus: z.number().positive().optional(),
  /** Allow network inside the sandbox (default false). */
  network: z.boolean().optional(),
});
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

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

/** Presentation settings for the TUI (theme preset, arthurian flavour). */
const uiSectionSchema = z
  .object({
    /** Named theme: `auto` (follow terminal) | `dark` | `light` | `daltonized` | `high-contrast`. */
    theme: z.enum(['auto', 'dark', 'light', 'daltonized', 'high-contrast']).optional(),
    /** Caption flavour for phase spinners: `plain` (default) | `arthurian`. */
    flavor: z.enum(['plain', 'arthurian']).optional(),
  })
  .optional();

/** Adversarial Verification Mesh policy (proportional by default; governable here). */
const verificationSectionSchema = z
  .object({
    /** off = never · auto = proportional to risk (default) · always = ≥1 lens on any change. */
    mesh: z.enum(['off', 'auto', 'always']).optional(),
  })
  .optional();

/** Hard budget cap (plan P2.3) — autonomy you can cap by dollars. */
const budgetSectionSchema = z
  .object({
    /**
     * Maximum model spend for a SINGLE run, in US dollars. When the run's
     * accumulated cost reaches this ceiling, the next model call is DENIED and
     * the run ends `failed` (needs-raise) — Excalibur does not just track spend,
     * it stops at the cap. Omit/`null` for no cap (the default).
     */
    maxRunUsd: z.number().positive().nullable().optional(),
  })
  .optional();

const baseExcaliburConfigSchema = z.object({
  version: z.number().int().optional(),
  /** Spoken UI locale for generated chrome/prose (`en`|`es`); auto-detected when absent. */
  language: z.string().optional(),
  /** TUI presentation (theme preset, flavour). */
  ui: uiSectionSchema,
  /** Adversarial Verification Mesh policy. */
  verification: verificationSectionSchema,
  /** Hard per-run budget cap (deny-by-dollars). */
  budget: budgetSectionSchema,
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
  compaction: compactionConfigSchema.optional(),
  mcp: mcpSectionSchema.optional(),
  sandbox: sandboxConfigSchema.optional(),
  instructions: z.object({ sources: z.array(instructionSourceRefSchema).optional() }).optional(),
  skills: z.object({ sources: z.array(skillSourceRefSchema).optional() }).optional(),
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
  compaction: DEFAULT_COMPACTION_CONFIG,
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
