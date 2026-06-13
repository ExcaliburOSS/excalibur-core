import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { BUILT_IN_EXTENSIONS, STANDARD_SAFE_POLICY_PRESET } from '@excalibur/built-in-extensions';
import type { RepoAnalysis } from '@excalibur/context-engine';
import type {
  ModelRoutingDefinition,
  PolicyPresetDefinition,
} from '@excalibur/declarative-schemas';
import { DEFAULT_PROVIDERS_CONFIG, type ProvidersFileConfig } from '@excalibur/model-gateway';
import type { DetectedSkill, InstructionSource } from '@excalibur/shared';
import { DEFAULT_METHODOLOGIES, DEFAULT_WORKFLOWS } from '@excalibur/workflow-schema';
import { EXCALIBUR_DIR } from '../config/load-config';
import { readTextIfExists, writeFileEnsured } from '../internal/fs-utils';

/**
 * `excalibur init` planning (Build Contract §4.6, onboarding spec §1–§3):
 *
 * - minimal (default): ONLY `config.yaml` + `instructions/general.md` +
 *   `extensions.yaml` (plus `models/providers.yaml` when provider setup was
 *   completed). Built-in catalogs work without local files.
 * - team: + instructions/{architecture,testing,security}.md +
 *   policies/{standard-safe,sensitive-paths}.yaml + models/{providers,routing}.yaml.
 * - full: exports every built-in catalog for inspection/customization.
 *
 * Detected values only — commands are never invented and instruction
 * references never point at non-existent paths. User-global sources are
 * referenced with `localOnly: true` and NEVER copied into the repository.
 */

export type InitMode = 'minimal' | 'team' | 'full';

export interface InitPlanFile {
  /** Path relative to the repository root (e.g. `.excalibur/config.yaml`). */
  relPath: string;
  content: string;
  /** Whether the file already exists in the repository (update mode). */
  exists: boolean;
}

export interface InitPlan {
  files: InitPlanFile[];
  summaryLines: string[];
}

export interface GenerateInitPlanOptions {
  mode: InitMode;
  /**
   * Result of the optional one-question provider setup (onboarding §4).
   * When provided, minimal mode also writes `models/providers.yaml`.
   */
  providers?: ProvidersFileConfig;
}

export interface ApplyInitPlanOptions {
  overwrite: boolean;
}

export interface ApplyInitPlanResult {
  written: string[];
  skipped: string[];
}

// --- content builders ---------------------------------------------------------

function projectName(analysis: RepoAnalysis): string {
  const packageJson = readTextIfExists(join(analysis.root, 'package.json'));
  if (packageJson !== null) {
    try {
      const parsed: unknown = JSON.parse(packageJson);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { name?: unknown }).name === 'string'
      ) {
        return (parsed as { name: string }).name;
      }
    } catch {
      // fall through to the directory name
    }
  }
  return basename(analysis.root);
}

function detectedCommands(analysis: RepoAnalysis): Record<string, string> {
  const commands: Record<string, string> = {};
  for (const key of ['test', 'lint', 'typecheck', 'build'] as const) {
    const command = analysis.commands[key];
    if (typeof command === 'string' && command.length > 0) {
      commands[key] = command;
    }
  }
  return commands;
}

function instructionSourceRefs(sources: InstructionSource[]): Array<Record<string, unknown>> {
  return sources
    .filter((source) => source.kind === 'instruction')
    .map((source) => {
      const isGlobal = source.scope === 'user_global';
      const path = isGlobal || source.path.startsWith('~/') ? source.path : `./${source.path}`;
      return {
        path,
        format: source.format,
        scope: source.scope,
        enabled: source.enabled,
        ...(isGlobal ? { localOnly: true } : {}),
      };
    });
}

function skillSourceRefs(skills: DetectedSkill[]): Array<Record<string, unknown>> {
  return skills.map((skill) => ({
    path: skill.scope === 'user_global' || skill.path.startsWith('~/') ? skill.path : `./${skill.path}`,
    scope: skill.scope,
    // review_required / untrusted skills are never auto-enabled (ISD §3).
    enabled: skill.enabled && skill.trustLevel === 'trusted',
    trustLevel: skill.trustLevel,
  }));
}

function buildConfigYaml(analysis: RepoAnalysis): string {
  const commands = detectedCommands(analysis);
  const config: Record<string, unknown> = {
    version: 1,
    project: {
      name: projectName(analysis),
      ...(analysis.packageManager !== null ? { packageManager: analysis.packageManager } : {}),
      ...(analysis.languages.length > 0 ? { languages: analysis.languages } : {}),
      ...(analysis.frameworks.length > 0 ? { frameworks: analysis.frameworks } : {}),
    },
    // Detected commands only — never invented (onboarding §1).
    commands,
    instructions: { sources: instructionSourceRefs(analysis.instructionSources) },
    ...(analysis.skills.length > 0 ? { skills: { sources: skillSourceRefs(analysis.skills) } } : {}),
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
  };
  return stringifyYaml(config);
}

function buildExtensionsYaml(): string {
  const header =
    '# Built-in Excalibur extension packs. Everything listed under `enabled`\n' +
    '# loads by default; move an id to `disabled` to switch a pack off.\n';
  return header + stringifyYaml({ enabled: BUILT_IN_EXTENSIONS.map((pack) => pack.manifest.id) });
}

function buildGeneralInstructions(analysis: RepoAnalysis): string {
  const commands = detectedCommands(analysis);
  const commandLines = Object.entries(commands).map(([key, value]) => `- ${key}: \`${value}\``);
  return [
    `# Project instructions — ${projectName(analysis)}`,
    '',
    'General guidance Excalibur prepends to every model prompt for this repository.',
    '',
    '## Detected stack',
    '',
    `- Languages: ${analysis.languages.join(', ') || 'unknown'}`,
    `- Frameworks: ${analysis.frameworks.join(', ') || 'none detected'}`,
    `- Package manager: ${analysis.packageManager ?? 'unknown'}`,
    '',
    '## Commands',
    '',
    commandLines.length > 0 ? commandLines.join('\n') : '_No commands detected._',
    '',
    '## Working agreements',
    '',
    '- Keep changes small and reviewable.',
    '- Never commit secrets; use environment variables.',
    '- Run the detected test and typecheck commands before declaring work done.',
    '',
  ].join('\n');
}

function buildArchitectureInstructions(analysis: RepoAnalysis): string {
  return [
    '# Architecture instructions',
    '',
    `- Backend detected: ${analysis.patterns.hasBackend ? 'yes' : 'no'}.`,
    `- Frontend detected: ${analysis.patterns.hasFrontend ? 'yes' : 'no'}.`,
    `- API directories: ${analysis.patterns.apiDirs.join(', ') || 'none detected'}.`,
    `- Domain directories: ${analysis.patterns.domainDirs.join(', ') || 'none detected'}.`,
    '',
    'Describe module boundaries, layering rules and dependency direction here.',
    '',
  ].join('\n');
}

function buildTestingInstructions(analysis: RepoAnalysis): string {
  const testCommand = analysis.commands.test;
  return [
    '# Testing instructions',
    '',
    `- Test directories: ${analysis.patterns.testDirs.join(', ') || 'none detected'}.`,
    testCommand !== undefined
      ? `- Run tests with \`${testCommand}\`.`
      : '- No test command detected — add one before relying on agent verification.',
    '',
    'Describe the testing strategy (unit/integration/e2e) and coverage expectations here.',
    '',
  ].join('\n');
}

function buildSecurityInstructions(analysis: RepoAnalysis): string {
  const sensitive = analysis.patterns.sensitivePaths;
  return [
    '# Security instructions',
    '',
    '- Never read or write `.env*` files, private keys or secret stores.',
    `- Sensitive paths detected: ${sensitive.join(', ') || 'none detected'}.`,
    '- Changes to authentication, billing or payment code require human review.',
    '',
  ].join('\n');
}

function sensitivePathGlobs(analysis: RepoAnalysis): string[] {
  const globs: string[] = [];
  for (const sensitivePath of analysis.patterns.sensitivePaths) {
    const normalized = sensitivePath.replace(/\\/g, '/');
    globs.push(normalized.includes('.') && !normalized.endsWith('/') ? normalized : `${normalized}/**`);
  }
  if (globs.length === 0) {
    globs.push('**/auth/**', '**/billing/**', '**/payments/**', '**/secrets/**', '.env', '.env.*');
  }
  return [...new Set(globs)];
}

function buildSensitivePathsPolicy(analysis: RepoAnalysis): string {
  const preset: PolicyPresetDefinition = {
    id: 'sensitive-paths',
    type: 'policy_preset',
    name: 'Sensitive Paths',
    description:
      'Writes to security-sensitive paths detected in this repository always require human approval.',
    rules: [
      {
        id: 'sensitive-writes-require-approval',
        when: { action: 'write', filePathMatches: sensitivePathGlobs(analysis) },
        decision: 'require_approval',
      },
    ],
  };
  return stringifyYaml(preset);
}

function buildModelRouting(): string {
  const routing: ModelRoutingDefinition = {
    id: 'default-routing',
    type: 'model_routing',
    name: 'Default Model Routing',
    description: 'Routes every role to the configured default provider (mock in M1).',
    default: 'mock',
    byRole: { planner: 'mock', implementer: 'mock', reviewer: 'mock', security: 'mock' },
  };
  return stringifyYaml(routing);
}

const MEMORY_FILES: ReadonlyArray<{ name: string; content: string }> = [
  {
    name: 'decisions.md',
    content:
      '# Decisions\n\nRecord important technical decisions here (one dated entry per decision).\n',
  },
  {
    name: 'known-risks.md',
    content:
      '# Known risks\n\nList known sharp edges, fragile areas and operational risks here.\n',
  },
  {
    name: 'domain-glossary.md',
    content:
      '# Domain glossary\n\nDefine the domain terms agents must use consistently in this repository.\n',
  },
];

// --- plan assembly --------------------------------------------------------------

interface PlannedFile {
  relPath: string;
  content: string;
}

function minimalFiles(analysis: RepoAnalysis, opts: GenerateInitPlanOptions): PlannedFile[] {
  const files: PlannedFile[] = [
    { relPath: `${EXCALIBUR_DIR}/config.yaml`, content: buildConfigYaml(analysis) },
    {
      relPath: `${EXCALIBUR_DIR}/instructions/general.md`,
      content: buildGeneralInstructions(analysis),
    },
    { relPath: `${EXCALIBUR_DIR}/extensions.yaml`, content: buildExtensionsYaml() },
  ];
  if (opts.providers !== undefined) {
    files.push({
      relPath: `${EXCALIBUR_DIR}/models/providers.yaml`,
      content: stringifyYaml(opts.providers),
    });
  }
  return files;
}

function teamFiles(analysis: RepoAnalysis, opts: GenerateInitPlanOptions): PlannedFile[] {
  const providers = opts.providers ?? DEFAULT_PROVIDERS_CONFIG;
  return [
    {
      relPath: `${EXCALIBUR_DIR}/instructions/architecture.md`,
      content: buildArchitectureInstructions(analysis),
    },
    {
      relPath: `${EXCALIBUR_DIR}/instructions/testing.md`,
      content: buildTestingInstructions(analysis),
    },
    {
      relPath: `${EXCALIBUR_DIR}/instructions/security.md`,
      content: buildSecurityInstructions(analysis),
    },
    {
      relPath: `${EXCALIBUR_DIR}/policies/standard-safe.yaml`,
      content: stringifyYaml(STANDARD_SAFE_POLICY_PRESET),
    },
    {
      relPath: `${EXCALIBUR_DIR}/policies/sensitive-paths.yaml`,
      content: buildSensitivePathsPolicy(analysis),
    },
    {
      relPath: `${EXCALIBUR_DIR}/models/providers.yaml`,
      content: stringifyYaml(providers),
    },
    { relPath: `${EXCALIBUR_DIR}/models/routing.yaml`, content: buildModelRouting() },
  ];
}

/** Directory per declarative contribution kind exported by `--full`. */
const FULL_EXPORT_DIRS: ReadonlyArray<{ kind: string; dirName: string }> = [
  { kind: 'question_pack', dirName: 'question-packs' },
  { kind: 'prompt_template', dirName: 'prompts' },
  { kind: 'artifact_template', dirName: 'artifacts' },
  { kind: 'report_template', dirName: 'reports' },
  { kind: 'role_definition', dirName: 'roles' },
  { kind: 'command_mapping', dirName: 'command-mappings' },
];

function fullCatalogFiles(): PlannedFile[] {
  const files: PlannedFile[] = [];

  // Workflows and methodologies keep their authored YAML sources.
  for (const workflow of DEFAULT_WORKFLOWS) {
    files.push({ relPath: `${EXCALIBUR_DIR}/workflows/${workflow.id}.yaml`, content: workflow.yaml });
  }
  for (const methodology of DEFAULT_METHODOLOGIES) {
    files.push({
      relPath: `${EXCALIBUR_DIR}/methodologies/${methodology.id}.yaml`,
      content: methodology.yaml,
    });
  }

  // Every other declarative kind is serialized from the built-in packs.
  for (const { kind, dirName } of FULL_EXPORT_DIRS) {
    for (const pack of BUILT_IN_EXTENSIONS) {
      for (const contribution of pack.contributions) {
        if (contribution.kind !== kind || contribution.definition === undefined) {
          continue;
        }
        files.push({
          relPath: `${EXCALIBUR_DIR}/${dirName}/${contribution.id}.yaml`,
          content: stringifyYaml(contribution.definition),
        });
      }
    }
  }

  for (const memory of MEMORY_FILES) {
    files.push({ relPath: `${EXCALIBUR_DIR}/memory/${memory.name}`, content: memory.content });
  }

  return files;
}

// --- summary (grouped detection report, ISD spec §5) -----------------------------

function detectionSummary(analysis: RepoAnalysis, mode: InitMode, files: InitPlanFile[]): string[] {
  const lines: string[] = [];
  const commands = detectedCommands(analysis);

  lines.push('Detected:');
  lines.push(`  - Languages: ${analysis.languages.join(', ') || 'unknown'}`);
  lines.push(`  - Frameworks: ${analysis.frameworks.join(', ') || 'none'}`);
  lines.push(`  - Package manager: ${analysis.packageManager ?? 'unknown'}`);
  const commandSummary = Object.entries(commands)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' / ');
  lines.push(`  - Commands: ${commandSummary.length > 0 ? commandSummary : 'none detected'}`);

  const projectInstructions = analysis.instructionSources.filter(
    (source) => source.kind === 'instruction' && source.scope === 'project',
  );
  if (projectInstructions.length > 0) {
    lines.push('Project instructions (used automatically):');
    for (const source of projectInstructions) {
      lines.push(`  ✓ ${source.path}`);
    }
  }

  if (analysis.skills.length > 0) {
    lines.push('Detected skills (review before enabling):');
    for (const skill of analysis.skills) {
      lines.push(`  ⚠ ${skill.name} — ${skill.path} (${skill.trustLevel})`);
    }
  }

  const globalSources = analysis.instructionSources.filter(
    (source) => source.scope === 'user_global',
  );
  if (globalSources.length > 0) {
    lines.push('Personal/global instructions (referenced locally only, never copied):');
    for (const source of globalSources) {
      lines.push(`  ⚠ ${source.path}`);
    }
  }

  lines.push('Safety: standard-safe — No files will be modified without approval.');

  const updates = files.filter((file) => file.exists);
  lines.push(`Files (${mode} mode):`);
  for (const file of files) {
    lines.push(`  ${file.exists ? '~' : '+'} ${file.relPath}${file.exists ? ' (exists — update mode)' : ''}`);
  }
  if (updates.length > 0) {
    lines.push(
      `Update mode: ${updates.length} file(s) already exist and will only change after confirmation.`,
    );
  }

  return lines;
}

// --- pinned API -------------------------------------------------------------------

/**
 * Builds the init plan for a repository analysis (never touches the disk
 * beyond existence checks). Minimal mode generates exactly `config.yaml`,
 * `instructions/general.md` and `extensions.yaml`.
 */
export function generateInitPlan(
  analysis: RepoAnalysis,
  opts: GenerateInitPlanOptions,
): InitPlan {
  const planned: PlannedFile[] = [...minimalFiles(analysis, opts)];
  if (opts.mode === 'team' || opts.mode === 'full') {
    planned.push(...teamFiles(analysis, opts));
  }
  if (opts.mode === 'full') {
    planned.push(...fullCatalogFiles());
  }

  const files: InitPlanFile[] = planned.map((file) => ({
    ...file,
    exists: existsSync(join(analysis.root, file.relPath)),
  }));

  return { files, summaryLines: detectionSummary(analysis, opts.mode, files) };
}

/**
 * Applies an init plan: writes every planned file, skipping existing files
 * unless `overwrite` is set (nothing is ever overwritten silently —
 * onboarding spec §1). Returns the written and skipped relative paths.
 */
export function applyInitPlan(
  repoRoot: string,
  plan: InitPlan,
  opts: ApplyInitPlanOptions,
): ApplyInitPlanResult {
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of plan.files) {
    const target = join(repoRoot, file.relPath);
    if (existsSync(target) && !opts.overwrite) {
      skipped.push(file.relPath);
      continue;
    }
    writeFileEnsured(target, file.content);
    written.push(file.relPath);
  }

  return { written, skipped };
}
