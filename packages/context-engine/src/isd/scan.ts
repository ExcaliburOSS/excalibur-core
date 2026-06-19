import * as os from 'node:os';
import * as path from 'node:path';
import {
  redactSecrets,
  resolveDefaultTrust,
  type InstructionSource,
  type InstructionSourceScope,
} from '@excalibur/shared';
import { globFiles, isDirectory, readTextFile, sha256Hex } from '../internal/fs-utils';
import { RepoAnalysisError } from '../errors';
import type { ScanInstructionSourcesInput } from '../types';
import { classifySourcePath, extractTitle, FORMAT_ORDER, makeSourceId } from './classify';

/** Redacts a possibly-null instruction title (untrusted file content). */
function redactTitle(title: string | null): string | null {
  return title === null ? null : redactSecrets(title);
}

/** Project-scope candidate globs (instructions-skills-core.md §1). */
const PROJECT_PATTERNS: readonly string[] = [
  'CLAUDE.md',
  '.claude/**/*.md',
  'skills/**/SKILL.md',
  '.skills/**/SKILL.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursor/rules.md',
  '.cursor/rules/**',
  '.github/copilot-instructions.md',
  '.codex/**',
  '.openai/**',
  '.windsurf/**',
  '.continue/**',
  '.aider.conf.yml',
  '.aiderignore',
  'README.md',
  'CONTRIBUTING.md',
  'docs/**/*.md',
  'adr/**/*.md',
  'adrs/**/*.md',
  'decisions/**/*.md',
];

/**
 * User-global scanning (ISD spec §1). Limited to the canonical global instruction
 * file and skill definitions — NOT the rest of `~/.claude`, which is Claude Code
 * tooling state (plans/, cache/, projects/, todos/, plugins/), not user instructions.
 * Vacuuming up every `.md` under `~/.claude` would flood the effective instruction
 * context with unrelated files and crowd out the project's real instructions.
 */
const USER_GLOBAL_PATTERNS: readonly string[] = [
  '.claude/CLAUDE.md',
  '.claude/skills/**/SKILL.md',
  '.skills/**/SKILL.md',
];

interface ScanTarget {
  root: string;
  scope: InstructionSourceScope;
  patterns: readonly string[];
}

async function scanTarget(target: ScanTarget, usedIds: Set<string>): Promise<InstructionSource[]> {
  if (!(await isDirectory(target.root))) {
    return [];
  }
  const relPaths = await globFiles(target.root, [...target.patterns]);
  const candidates: Array<{
    relPath: string;
    format: NonNullable<ReturnType<typeof classifySourcePath>>;
  }> = [];
  for (const relPath of relPaths) {
    const format = classifySourcePath(relPath, target.scope);
    if (format !== null) {
      candidates.push({ relPath, format });
    }
  }
  // Deterministic order: format precedence, then path.
  candidates.sort((a, b) => {
    const byFormat = FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format);
    return byFormat !== 0 ? byFormat : a.relPath.localeCompare(b.relPath);
  });

  const sources: InstructionSource[] = [];
  for (const { relPath, format } of candidates) {
    const absolutePath = path.join(target.root, ...relPath.split('/'));
    const content = await readTextFile(absolutePath);
    if (content === null) {
      continue; // unreadable or oversized files are skipped, never fatal
    }
    const { trustLevel, kind } = resolveDefaultTrust(format, target.scope);
    sources.push({
      id: makeSourceId(format, target.scope, relPath, usedIds),
      scope: target.scope,
      format,
      kind,
      path: target.scope === 'user_global' ? `~/${relPath}` : relPath,
      // Title is derived from untrusted file content (front matter / first
      // heading) and surfaces in `instructions list/inspect` — redact secrets.
      title: redactTitle(extractTitle(content)),
      contentHash: sha256Hex(content),
      trustLevel,
      // Only sources trusted by default are enabled automatically;
      // review_required/untrusted sources (e.g. skills) stay opt-in.
      enabled: trustLevel === 'trusted',
      importedAs: kind,
      metadata: {
        absolutePath,
        relativePath: relPath,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
      },
    });
  }
  return sources;
}

/**
 * Scans a repository (and optionally the user's home directory) for AI
 * instruction sources: CLAUDE.md/AGENTS.md/GEMINI.md, Cursor rules, Copilot
 * instructions, Codex/Aider configs, SKILL.md files, project docs and ADRs.
 *
 * Classification, kind and trust defaults come from `DEFAULT_TRUST_RULES`
 * (`@excalibur/shared`); `contentHash` is the sha256 of the file content;
 * ids are stable (`claude-project`, `skill-<dirname>`, `docs-readme`, …).
 *
 * User-global scanning (`~/.claude/**`) is opt-in: it runs when
 * `includeUserGlobal` is true, or when an explicit `homeDir` is injected.
 */
export async function scanInstructionSources(
  input: ScanInstructionSourcesInput,
): Promise<InstructionSource[]> {
  if (!(await isDirectory(input.repoRoot))) {
    throw new RepoAnalysisError(
      `Cannot scan instruction sources: '${input.repoRoot}' is not a directory`,
      { repoRoot: input.repoRoot },
    );
  }
  const includeUserGlobal = input.includeUserGlobal ?? input.homeDir !== undefined;

  const usedIds = new Set<string>();
  const sources = await scanTarget(
    { root: input.repoRoot, scope: 'project', patterns: PROJECT_PATTERNS },
    usedIds,
  );

  if (includeUserGlobal) {
    const homeDir = input.homeDir ?? os.homedir();
    const globalSources = await scanTarget(
      { root: homeDir, scope: 'user_global', patterns: USER_GLOBAL_PATTERNS },
      usedIds,
    );
    sources.push(...globalSources);
  }
  return sources;
}
