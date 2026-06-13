import type { DetectedSkill, InstructionSource } from '@excalibur/shared';

/** Package managers Excalibur can detect (Build Contract §4.5). */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Canonical commands detected from the repository (never invented). */
export interface DetectedCommands {
  test?: string;
  lint?: string;
  typecheck?: string;
  build?: string;
}

/** Classification of well-known instruction files for `RepoAnalysis`. */
export type InstructionFileKind =
  | 'agents_md'
  | 'claude_md'
  | 'cursor_rules'
  | 'copilot_instructions'
  | 'readme'
  | 'architecture_doc'
  | 'adr'
  | 'other';

export interface DetectedInstructionFile {
  /** Repo-relative POSIX path. */
  path: string;
  kind: InstructionFileKind;
}

/** Structural patterns detected in the repository. */
export interface RepoPatterns {
  hasBackend: boolean;
  hasFrontend: boolean;
  testDirs: string[];
  migrationDirs: string[];
  apiDirs: string[];
  domainDirs: string[];
  sensitivePaths: string[];
}

/** Language / framework / package-manager detection result. */
export interface DetectedStack {
  languages: string[];
  frameworks: string[];
  packageManager: PackageManager | null;
}

/**
 * Full repository analysis (Build Contract §4.5), including the
 * Instruction/Skill Discovery results (`instructionSources`, `skills`).
 */
export interface RepoAnalysis {
  root: string;
  languages: string[];
  frameworks: string[];
  packageManager: PackageManager | null;
  commands: DetectedCommands;
  instructionFiles: DetectedInstructionFile[];
  patterns: RepoPatterns;
  suggestedWorkflows: string[];
  instructionSources: InstructionSource[];
  skills: DetectedSkill[];
}

/** Input for the ISD scanner functions. */
export interface ScanInstructionSourcesInput {
  repoRoot: string;
  /**
   * Home directory used for user-global scanning. Injectable for tests;
   * defaults to `os.homedir()` when user-global scanning is enabled.
   */
  homeDir?: string;
  /**
   * Whether to scan `~/.claude/**` user-global sources. Defaults to `true`
   * when an explicit `homeDir` is provided, `false` otherwise
   * (`analyzeRepository` never enables it by default; the CLI opts in).
   */
  includeUserGlobal?: boolean;
}

/** Structured result of parsing a SKILL.md file. */
export interface ParsedSkillMd {
  /** The file path the content was parsed from (as given by the caller). */
  sourcePath: string;
  name: string | null;
  description: string | null;
  /** "When to use" entries. */
  triggers: string[];
  dependencies: string[];
  toolsRequired: string[];
  /** Body of the instructions/usage section, when present. */
  instructions: string | null;
}
