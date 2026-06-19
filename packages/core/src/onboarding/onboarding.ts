import { minimatch } from 'minimatch';
import { PermissionEngine } from '@excalibur/agent-runtime';
import {
  STANDARD_SAFE_BLOCKED_PATHS,
  STANDARD_SAFE_POLICY_PRESET,
} from '@excalibur/built-in-extensions';
import type { RepoAnalysis } from '@excalibur/context-engine';
import type { PolicyPresetDefinition } from '@excalibur/declarative-schemas';
import {
  DEFAULT_ALLOWED_COMMANDS,
  type AutonomyLevel,
  type ExcaliburConfig,
} from '@excalibur/shared';

/**
 * Out-of-the-box onboarding helpers (Build Contract §4.6, onboarding spec
 * §5–§6): the command → workflow/autonomy mapping table, the `standard-safe`
 * safety preset and the deterministic task-intent classifier.
 */

// --- Command defaults (ONB-5) ------------------------------------------------

export type CommandEntity = 'interaction' | 'patch' | 'run' | 'discovery';

export interface CommandDefault {
  command: string;
  entity: CommandEntity;
  autonomyLevel: AutonomyLevel;
  workflow: string;
  notes: string;
}

/** The onboarding spec §6 command table as data. */
export const COMMAND_DEFAULTS: Readonly<Record<string, CommandDefault>> = {
  ask: {
    command: 'ask',
    entity: 'interaction',
    autonomyLevel: 1,
    workflow: 'ask-repo',
    notes: 'never changes code',
  },
  review: {
    command: 'review',
    entity: 'interaction',
    autonomyLevel: 0,
    workflow: 'review-only',
    notes: 'never changes code',
  },
  patch: {
    command: 'patch',
    entity: 'patch',
    autonomyLevel: 2,
    workflow: 'propose-patch',
    notes: 'apply requires confirmation',
  },
  run: {
    command: 'run',
    entity: 'run',
    autonomyLevel: 3,
    workflow: 'standard-feature',
    notes: 'fast-fix or standard-feature by intent; branch/worktree isolation when possible',
  },
  careful: {
    command: 'run --careful',
    entity: 'run',
    autonomyLevel: 4,
    workflow: 'structured-feature',
    notes: 'structured-feature / security-review / migration by intent; stronger approvals',
  },
  explore: {
    command: 'run --explore',
    entity: 'run',
    autonomyLevel: 3,
    workflow: 'explore-alternatives',
    notes: 'engineering alternatives, never "model comparison"',
  },
  discovery: {
    command: 'discovery',
    entity: 'discovery',
    autonomyLevel: 0,
    workflow: 'discovery',
    notes: 'never changes code',
  },
};

// --- Safety presets (ONB-6) --------------------------------------------------

export interface SafetyPreset {
  id: string;
  name: string;
  description: string;
  /** Permission set used to derive the agent-runtime `PermissionEngine`. */
  permissions: NonNullable<ExcaliburConfig['permissions']>;
  /** Declarative twin (registered by the `core-policies` built-in pack). */
  policyPreset: PolicyPresetDefinition;
}

/**
 * `standard-safe` (onboarding spec §5): reads allowed except blocked paths,
 * every mutating action asks, push and external network access disabled,
 * secrets redacted. Blocked paths extend OSS §17 with `**\/*.p12`,
 * `**\/*.pfx` and `.git/**`.
 */
const STANDARD_SAFE_PRESET: SafetyPreset = {
  id: 'standard-safe',
  name: 'Standard Safe',
  description:
    'No files will be modified, no patches applied and no unknown commands run without approval. Push and external network access are disabled. Secrets are redacted from prompts and logs.',
  permissions: {
    tools: {
      read_file: true,
      list_files: true,
      search_code: true,
      git_diff: true,
      write_file: 'ask',
      apply_patch: 'ask',
      run_command: 'ask',
      run_tests: 'ask',
      create_branch: 'ask',
      open_pr: 'ask',
      push: false,
      network: false,
    },
    blockedPaths: [...STANDARD_SAFE_BLOCKED_PATHS],
    allowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
  },
  policyPreset: STANDARD_SAFE_POLICY_PRESET,
};

/** Built-in safety presets, keyed by id (Build Contract §4.6). */
export const SAFETY_PRESETS: Readonly<Record<string, SafetyPreset>> = {
  'standard-safe': STANDARD_SAFE_PRESET,
};

/** The default preset id used when the config does not name one. */
export const DEFAULT_SAFETY_PRESET_ID = 'standard-safe';

/**
 * Derives the `PermissionEngine` for a repository configuration: the active
 * safety preset feeds the baseline, the config's explicit permissions merge
 * on top (tools merge per key; path/command lists are unioned so a sparse
 * config never weakens the preset), and detected commands join the allowlist
 * (onboarding §5: detected test/lint/typecheck/build ask instead of being
 * treated as unknown commands).
 */
export function permissionEngineForConfig(config: ExcaliburConfig): PermissionEngine {
  const presetId = config.safety?.preset ?? DEFAULT_SAFETY_PRESET_ID;
  const preset = SAFETY_PRESETS[presetId] ?? STANDARD_SAFE_PRESET;

  const tools = { ...preset.permissions.tools, ...config.permissions?.tools };
  const blockedPaths = [
    ...new Set([
      ...(preset.permissions.blockedPaths ?? []),
      ...(config.permissions?.blockedPaths ?? []),
    ]),
  ];
  const detectedCommands = Object.values(config.commands ?? {}).filter(
    (command): command is string => typeof command === 'string' && command.length > 0,
  );
  const allowedCommands = [
    ...new Set([
      ...(preset.permissions.allowedCommands ?? []),
      ...(config.permissions?.allowedCommands ?? []),
      ...detectedCommands,
    ]),
  ];

  return new PermissionEngine({ tools, blockedPaths, allowedCommands });
}

// --- Task intent classification (ONB-5 §10) ----------------------------------

export type TaskType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'migration'
  | 'security'
  | 'docs'
  | 'ambiguous'
  | 'alternatives';

export interface TaskIntent {
  taskType: TaskType;
  sensitive: boolean;
  sensitiveAreas: string[];
  recommendDiscoveryFirst: boolean;
  recommendedWorkflow: string;
  recommendedAutonomy: AutonomyLevel;
  reason: string;
}

interface SensitiveRule {
  area: string;
  pattern: RegExp;
}

/** Onboarding §6 sensitive-area keyword list. */
const SENSITIVE_RULES: ReadonlyArray<SensitiveRule> = [
  {
    area: 'auth',
    pattern:
      /\b(auth|authn|authz|authentication|authorization|login|logout|session|sso|oauth|jwt)\b/i,
  },
  { area: 'billing', pattern: /\b(billing|invoice|invoicing|subscription|pricing)\b/i },
  {
    area: 'payments',
    pattern: /\b(payment|payments|payout|escrow|charge|refund|checkout|stripe)\b/i,
  },
  { area: 'contracts/signing', pattern: /\b(signing|signature|e-?sign)\b/i },
  {
    area: 'security',
    pattern:
      /\b(security|vulnerab\w*|exploit|secret|secrets|credential\w*|token|password|encryption|csrf|xss)\b/i,
  },
  { area: 'pii', pattern: /\b(pii|gdpr|personal data|privacy)\b/i },
  { area: 'legal', pattern: /\b(legal|compliance|consent|audit)\b/i },
  { area: 'migrations', pattern: /\b(migration|migrations|migrate|schema change)\b/i },
  {
    area: 'infrastructure',
    pattern: /\b(infrastructure|terraform|kubernetes|k8s|helm|deploy pipeline|ci\/cd)\b/i,
  },
];

const ALTERNATIVES_PATTERN =
  /\b(alternative|alternatives|approaches|options|compare|comparison|trade-?offs?|explore|evaluate)\b/i;
const MIGRATION_PATTERN = /\b(migrat\w*|schema change|upgrade (?:the )?(?:database|db))\b/i;
const SECURITY_TASK_PATTERN =
  /\b(security|vulnerab\w*|exploit|harden|secret|secrets|credential\w*|token leak|encryption|csrf|xss|injection)\b/i;
const DOCS_PATTERN = /\b(docs?|documentation|readme|changelog|docstring|comments?)\b/i;
const REFACTOR_PATTERN =
  /\b(refactor\w*|rename|restructure|reorganize|extract|clean ?up|simplify|deduplicate)\b/i;
const BUGFIX_PATTERN =
  /\b(fix|fixes|bug|broken|crash\w*|typo|regression|defect|fails?|failing|error|wrong|incorrect|duplicat\w*)\b/i;
const FEATURE_PATTERN =
  /\b(add|adds|implement\w*|create|build|support|introduce|integrate|enable|new)\b/i;

/** File-ish path mentions in a task description (`src/auth/login.ts`, `prisma/migrations`). */
const TASK_PATH_PATTERN = /[\w.-]+(?:\/[\w.-]+)+/g;

/**
 * Whether `term` appears in `haystack` on word/path boundaries (not glued to a
 * surrounding word). So `auth` matches "src/auth/x" and "use auth" but NOT
 * "author"; case-insensitive. Prevents the substring false positives that made
 * unrelated tasks read as touching a sensitive area.
 */
function mentionsTerm(haystack: string, term: string): boolean {
  if (term.length === 0) {
    return false;
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\w])${escaped}(?:[^\\w]|$)`, 'i').test(haystack);
}

function sensitiveAreasFor(
  task: string,
  analysis: RepoAnalysis,
  config: ExcaliburConfig,
): string[] {
  const areas: string[] = [];
  for (const rule of SENSITIVE_RULES) {
    if (rule.pattern.test(task) && !areas.includes(rule.area)) {
      areas.push(rule.area);
    }
  }

  const mentionedPaths = task.match(TASK_PATH_PATTERN) ?? [];

  // Repository-detected sensitive paths (auth/billing/payments dirs, .env*).
  for (const sensitivePath of analysis.patterns.sensitivePaths) {
    const normalized = sensitivePath.replace(/\\/g, '/');
    // Match on word/path boundaries, NOT raw substring — otherwise `auth`
    // matches "author", `data` matches "database", `api` matches "rapid", etc.
    const hit =
      mentionsTerm(task, normalized) ||
      mentionedPaths.some((mentioned) => mentionsTerm(mentioned, normalized));
    if (hit && !areas.includes(normalized)) {
      areas.push(normalized);
    }
  }

  // Config `autonomy.paths` hits (onboarding §6).
  for (const [pattern, level] of Object.entries(config.autonomy?.paths ?? {})) {
    if (level >= 3) {
      continue; // only restrictive overrides mark a path as sensitive
    }
    const hit = mentionedPaths.some((mentioned) => minimatch(mentioned, pattern, { dot: true }));
    if (hit && !areas.includes(pattern)) {
      areas.push(pattern);
    }
  }

  return areas;
}

function isAmbiguous(task: string, matchedCategory: boolean): boolean {
  const words = task
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  return words.length < 3 || !matchedCategory;
}

/**
 * Deterministic task-intent heuristics (onboarding spec §6/§10): keyword and
 * context based, never a model call. Decides the recommended workflow and
 * autonomy level for `excalibur run "<task>"`.
 */
export function classifyTaskIntent(
  task: string,
  analysis: RepoAnalysis,
  config: ExcaliburConfig,
): TaskIntent {
  const text = task.trim();
  const sensitiveAreas = sensitiveAreasFor(text, analysis, config);
  const sensitive = sensitiveAreas.length > 0;
  const hasTestCommand = typeof analysis.commands.test === 'string';

  const wantsAlternatives = ALTERNATIVES_PATTERN.test(text);
  const isMigration = MIGRATION_PATTERN.test(text);
  const isSecurity = SECURITY_TASK_PATTERN.test(text);
  const isDocs = DOCS_PATTERN.test(text);
  const isRefactor = REFACTOR_PATTERN.test(text);
  const isBugfix = BUGFIX_PATTERN.test(text);
  const isFeature = FEATURE_PATTERN.test(text);

  const matchedCategory =
    wantsAlternatives || isMigration || isSecurity || isDocs || isRefactor || isBugfix || isFeature;

  const weakTestsNote = !hasTestCommand
    ? ' No test command was detected — consider a plan or patch (Level ≤ 2) before a full agent run.'
    : '';

  if (isAmbiguous(text, matchedCategory)) {
    return {
      taskType: 'ambiguous',
      sensitive,
      sensitiveAreas,
      recommendDiscoveryFirst: true,
      recommendedWorkflow: 'discovery',
      recommendedAutonomy: 0,
      reason:
        'The task is short or has no clear action verb and acceptance criteria — run Discovery first to clarify it before implementation.',
    };
  }

  if (wantsAlternatives) {
    return {
      taskType: 'alternatives',
      sensitive,
      sensitiveAreas,
      recommendDiscoveryFirst: false,
      recommendedWorkflow: 'explore-alternatives',
      recommendedAutonomy: sensitive ? 4 : 3,
      reason:
        'The task asks to compare approaches — explore engineering alternatives before committing to one.' +
        (sensitive ? ` Sensitive areas involved: ${sensitiveAreas.join(', ')}.` : ''),
    };
  }

  if (isMigration) {
    return {
      taskType: 'migration',
      sensitive: true,
      sensitiveAreas: sensitiveAreas.includes('migrations')
        ? sensitiveAreas
        : ['migrations', ...sensitiveAreas],
      recommendDiscoveryFirst: false,
      recommendedWorkflow: 'migration',
      recommendedAutonomy: 4,
      reason:
        'The task involves a migration — use the migration workflow with backward-compatibility checks and human approval gates.' +
        weakTestsNote,
    };
  }

  if (isSecurity) {
    return {
      taskType: 'security',
      sensitive: true,
      sensitiveAreas: sensitiveAreas.includes('security')
        ? sensitiveAreas
        : ['security', ...sensitiveAreas],
      recommendDiscoveryFirst: false,
      recommendedWorkflow: 'security-review',
      recommendedAutonomy: 4,
      reason:
        'The task touches security-relevant behavior — run carefully with a security review and human approval gates.' +
        weakTestsNote,
    };
  }

  if (sensitive) {
    const taskType: TaskType = isRefactor
      ? 'refactor'
      : isBugfix
        ? 'bugfix'
        : isDocs
          ? 'docs'
          : 'feature';
    return {
      taskType,
      sensitive: true,
      sensitiveAreas,
      recommendDiscoveryFirst: false,
      recommendedWorkflow: 'structured-feature',
      recommendedAutonomy: 4,
      reason:
        `The task touches sensitive areas (${sensitiveAreas.join(', ')}) — run carefully with the structured workflow and stronger approvals.` +
        weakTestsNote,
    };
  }

  if (isDocs && !isFeature && !isBugfix) {
    return {
      taskType: 'docs',
      sensitive: false,
      sensitiveAreas,
      recommendDiscoveryFirst: false,
      recommendedWorkflow: 'fast-fix',
      recommendedAutonomy: 3,
      reason: 'Documentation-only change — the fast-fix workflow is enough.',
    };
  }

  if (isRefactor) {
    return {
      taskType: 'refactor',
      sensitive: false,
      sensitiveAreas,
      recommendDiscoveryFirst: false,
      recommendedWorkflow: 'safe-refactor',
      recommendedAutonomy: 3,
      reason:
        'The task is a refactor with no intended behavior change — use the safe-refactor workflow with baseline tests.' +
        weakTestsNote,
    };
  }

  if (isBugfix) {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    // `match` instead of `test`: TASK_PATH_PATTERN is global (stateful lastIndex).
    const mentionsPath = (text.match(TASK_PATH_PATTERN) ?? []).length > 0;
    const narrow = words.length <= 14 || mentionsPath;
    return {
      taskType: 'bugfix',
      sensitive: false,
      sensitiveAreas,
      recommendDiscoveryFirst: false,
      recommendedWorkflow: narrow ? 'fast-fix' : 'standard-feature',
      recommendedAutonomy: 3,
      reason: narrow
        ? 'Small, narrowly-scoped bugfix — the fast-fix workflow applies a patch with verification.'
        : 'Bugfix with a broader scope — use the standard feature workflow.' + weakTestsNote,
    };
  }

  return {
    taskType: 'feature',
    sensitive: false,
    sensitiveAreas,
    recommendDiscoveryFirst: false,
    recommendedWorkflow: 'standard-feature',
    recommendedAutonomy: 3,
    reason: 'Normal feature work — the standard feature workflow fits.' + weakTestsNote,
  };
}
