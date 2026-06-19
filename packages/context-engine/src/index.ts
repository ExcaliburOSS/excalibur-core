/**
 * @excalibur/context-engine — repository analysis for Excalibur Core:
 * stack/command/instruction/pattern detection (Build Contract §4.5) and the
 * Instruction/Skill Discovery scanner (instructions-skills-core.md §1–§3).
 */
export { analyzeRepository, type AnalyzeRepositoryOptions } from './analyze';
export { detectStack } from './stack';
export { detectCommands } from './commands';
export { detectInstructionFiles } from './instruction-files';
export { detectPatterns } from './patterns';
export { suggestWorkflows } from './workflows';
export { scanInstructionSources } from './isd/scan';
export { detectSkills, parseSkillMd, skillsFromSources } from './isd/skills';
export { RepoAnalysisError } from './errors';
export {
  searchRepoCode,
  tokenizeQuery,
  type CodeSearchOptions,
  type CodeSearchHit,
  type CodeSnippet,
  type CodeSearchResult,
} from './search/code-search';
export { isSecretPath, SECRET_DIR_NAMES } from './search/secret-paths';
export { SENSITIVE_DIR_NAMES } from './patterns';
export type {
  DetectedCommands,
  DetectedInstructionFile,
  DetectedStack,
  InstructionFileKind,
  PackageManager,
  ParsedSkillMd,
  RepoAnalysis,
  RepoPatterns,
  ScanInstructionSourcesInput,
} from './types';
