import { detectCommands } from './commands';
import { RepoAnalysisError } from './errors';
import { isDirectory } from './internal/fs-utils';
import { detectInstructionFiles } from './instruction-files';
import { detectPatterns } from './patterns';
import { scanInstructionSources } from './isd/scan';
import { skillsFromSources } from './isd/skills';
import { detectStack } from './stack';
import type { RepoAnalysis } from './types';
import { suggestWorkflows } from './workflows';

export interface AnalyzeRepositoryOptions {
  /**
   * Injectable home directory for user-global instruction scanning
   * (defaults to `os.homedir()` when `includeUserGlobal` is true).
   */
  homeDir?: string;
  /**
   * Scan `~/.claude/**` user-global sources. Off by default — the CLI opts
   * in explicitly (Build Contract §4.5).
   */
  includeUserGlobal?: boolean;
}

/**
 * Analyzes a repository: stack, commands, instruction files, structural
 * patterns, workflow suggestions, plus the Instruction/Skill Discovery
 * results (`instructionSources`, `skills`).
 */
export async function analyzeRepository(
  dir: string,
  options?: AnalyzeRepositoryOptions,
): Promise<RepoAnalysis> {
  if (!(await isDirectory(dir))) {
    throw new RepoAnalysisError(`Cannot analyze repository: '${dir}' is not a directory`, {
      dir,
    });
  }

  const includeUserGlobal = options?.includeUserGlobal ?? false;
  const [stack, commands, instructionFiles, patterns, instructionSources] = await Promise.all([
    detectStack(dir),
    detectCommands(dir),
    detectInstructionFiles(dir),
    detectPatterns(dir),
    scanInstructionSources({
      repoRoot: dir,
      ...(options?.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      includeUserGlobal,
    }),
  ]);
  const skills = await skillsFromSources(instructionSources);

  return {
    root: dir,
    languages: stack.languages,
    frameworks: stack.frameworks,
    packageManager: stack.packageManager,
    commands,
    instructionFiles,
    patterns,
    suggestedWorkflows: suggestWorkflows(stack, patterns),
    instructionSources,
    skills,
  };
}
