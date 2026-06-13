import { globFiles } from './internal/fs-utils';
import type { DetectedInstructionFile, InstructionFileKind } from './types';

interface InstructionFileRule {
  kind: InstructionFileKind;
  patterns: string[];
}

/**
 * Well-known instruction file locations (oss-spec §5 step 5), in stable
 * output order. The richer ISD scanner lives in `isd/scan.ts`; this detector
 * feeds the coarse `RepoAnalysis.instructionFiles` view.
 */
const RULES: ReadonlyArray<InstructionFileRule> = [
  { kind: 'agents_md', patterns: ['AGENTS.md'] },
  { kind: 'claude_md', patterns: ['CLAUDE.md', '.claude/CLAUDE.md'] },
  { kind: 'cursor_rules', patterns: ['.cursor/rules.md', '.cursor/rules/**'] },
  { kind: 'copilot_instructions', patterns: ['.github/copilot-instructions.md'] },
  { kind: 'readme', patterns: ['README.md'] },
  {
    kind: 'architecture_doc',
    patterns: ['ARCHITECTURE.md', 'docs/architecture.md', 'docs/ARCHITECTURE.md'],
  },
  {
    kind: 'adr',
    patterns: [
      'adr/**/*.md',
      'adrs/**/*.md',
      'decisions/**/*.md',
      'docs/adr/**/*.md',
      'docs/adrs/**/*.md',
      'docs/decisions/**/*.md',
    ],
  },
  {
    kind: 'other',
    patterns: [
      'GEMINI.md',
      'CONTRIBUTING.md',
      '.aider.conf.yml',
      '.aiderignore',
      '.codex/**/*.md',
      'docs/**/*.md',
    ],
  },
];

/**
 * Detects existing AI instruction files, README, architecture docs and ADRs.
 * Returns repo-relative POSIX paths; each file is reported once with its
 * most specific kind.
 */
export async function detectInstructionFiles(dir: string): Promise<DetectedInstructionFile[]> {
  const found: DetectedInstructionFile[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    const matches = await globFiles(dir, rule.patterns);
    for (const path of matches) {
      if (!seen.has(path)) {
        seen.add(path);
        found.push({ path, kind: rule.kind });
      }
    }
  }
  return found;
}
