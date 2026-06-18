import { join } from 'node:path';
import { scanInstructionSources } from '@excalibur/context-engine';
import { redactSecrets } from '@excalibur/model-gateway';
import type { ExcaliburConfig, InstructionSource } from '@excalibur/shared';
import { EXCALIBUR_DIR, loadExcaliburConfig } from '../config/load-config';
import { listFiles, readTextIfExists, sha256Hex } from '../internal/fs-utils';

/**
 * EffectiveInstructionBuilder (ISD-4, instructions-skills-core.md §8).
 *
 * Builds the source-aware instruction context prepended to every model
 * prompt: precedence ordering (§4), per-source headers, contentHash dedupe,
 * secret redaction, skill exclusion, conflict warnings and context caps.
 */

/** Per-source character cap (ISD spec §8, M1). */
export const INSTRUCTION_SOURCE_CHAR_CAP = 4000;
/** Total effective-context character cap (ISD spec §8, M1). */
export const INSTRUCTION_TOTAL_CHAR_CAP = 24000;
/** Marker appended where content was truncated to fit the caps. */
export const SUMMARIZED_MARKER = '…summarized';

const HEADER_LINE = 'Effective project instructions:';

/**
 * Caller-supplied context injected alongside the discovered instruction
 * sources (M2 repo-context retrieval). Each becomes a candidate source at
 * precedence 6 (below instruction files, above skills), so it flows through
 * the exact same dedupe + render path: secret redaction and the per-source /
 * total caps apply automatically. Purely additive — existing callers pass
 * nothing and get byte-identical behavior.
 */
export interface AdditionalContextSource {
  /** Display path / label for the source header. */
  path: string;
  /** Raw content (pre-redaction); redaction happens in render(). */
  content: string;
  /** Precedence bucket; defaults to 6 (repo-context level). */
  precedence?: number;
  /** Optional human title recorded on the InstructionSource. */
  title?: string;
}

export interface EffectiveInstructionsInput {
  repositoryPath: string;
  workflowId?: string;
  autonomyLevel?: number;
  includeUserGlobal?: boolean;
  enabledSkills?: string[];
  /** Retrieved repo-context sources injected at precedence 6 (M2). */
  additionalSources?: AdditionalContextSource[];
}

export interface EffectiveInstructions {
  instructionsMarkdown: string;
  sources: InstructionSource[];
  warnings: string[];
}

interface CandidateSource {
  source: InstructionSource;
  content: string;
  /** Precedence bucket, lower = higher priority (ISD spec §4). */
  precedence: number;
}

/** Project instruction formats at precedence level 3 (repository instructions). */
const REPO_INSTRUCTION_FORMATS: ReadonlySet<string> = new Set([
  'claude_md',
  'agents_md',
  'cursor_rules',
  'copilot_instructions',
  'gemini_md',
  'codex',
  'aider',
]);

const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn', 'bun'] as const;
type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

/** `pnpm test`, `npm run lint`, `yarn install`, … */
const PM_USAGE_PATTERN =
  /\b(pnpm|npm|yarn|bun)\b(?=\s+(?:run|test|install|add|lint|build|typecheck|exec)\b)/g;

function normalizeConfigPath(path: string): string {
  let normalized = path.replace(/\\/g, '/').trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function configuredPackageManager(config: ExcaliburConfig): PackageManagerName | null {
  const declared = config.project?.packageManager;
  if (declared !== undefined && (PACKAGE_MANAGERS as readonly string[]).includes(declared)) {
    return declared as PackageManagerName;
  }
  for (const command of Object.values(config.commands ?? {})) {
    if (typeof command !== 'string') {
      continue;
    }
    const first = command.trim().split(/\s+/)[0];
    if (first !== undefined && (PACKAGE_MANAGERS as readonly string[]).includes(first)) {
      return first as PackageManagerName;
    }
  }
  return null;
}

function absolutePathOf(source: InstructionSource, repoRoot: string): string | null {
  const fromMetadata = source.metadata['absolutePath'];
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) {
    return fromMetadata;
  }
  if (source.path.startsWith('~/')) {
    return null; // user-global without recorded absolute path: skip
  }
  return join(repoRoot, normalizeConfigPath(source.path));
}

function headerFor(source: InstructionSource): string {
  if (source.scope === 'user_global') {
    return `[Source: ${source.path}, local user preference]`;
  }
  if (source.kind === 'skill') {
    return `[Source: ${source.path}, enabled skill]`;
  }
  return `[Source: ${source.path}]`;
}

function truncate(content: string, cap: number): { text: string; truncated: boolean } {
  if (content.length <= cap) {
    return { text: content, truncated: false };
  }
  return { text: `${content.slice(0, cap).trimEnd()}\n\n${SUMMARIZED_MARKER}`, truncated: true };
}

export class EffectiveInstructionBuilder {
  private readonly repoRoot: string;

  constructor(deps: { repoRoot: string }) {
    this.repoRoot = deps.repoRoot;
  }

  /**
   * Builds the effective instruction context for a repository.
   * Never throws on missing files or directories — instructions are optional.
   */
  async build(input: EffectiveInstructionsInput): Promise<EffectiveInstructions> {
    const repoRoot = input.repositoryPath.length > 0 ? input.repositoryPath : this.repoRoot;
    const warnings: string[] = [];
    const { config } = loadExcaliburConfig(repoRoot);

    const includeUserGlobal = input.includeUserGlobal ?? false;
    const scanned = await scanInstructionSources({ repoRoot, includeUserGlobal });

    let candidates: CandidateSource[] = [];

    // Level 2 — repository `.excalibur` instructions (+ level 4 workflow file).
    candidates.push(...this.excaliburInstructionSources(repoRoot, input.workflowId));

    // Levels 3, 5, 6, 7 — scanned sources with config overrides applied.
    for (const source of scanned) {
      const candidate = this.classifyScanned(source, config, input, repoRoot, includeUserGlobal);
      if (candidate !== null) {
        candidates.push(candidate);
      }
    }

    // Level 6 — caller-supplied repo-context (M2 retrieval), below instruction
    // files (2–5) and above skills (7). Flows through the same render path.
    candidates.push(...this.additionalContextSources(input.additionalSources));

    // Sort by precedence, then by ORIGINAL insertion order as an explicit
    // tiebreak — so the within-precedence ordering (e.g. general.md leading the
    // repo instructions) is deterministic by construction, not reliant on the
    // JS engine's sort being stable.
    candidates = candidates
      .map((candidate, order) => ({ candidate, order }))
      .sort((a, b) => a.candidate.precedence - b.candidate.precedence || a.order - b.order)
      .map((entry) => entry.candidate);

    // Dedupe overlapping files by content hash — highest precedence wins.
    const seenHashes = new Set<string>();
    const included: CandidateSource[] = [];
    for (const candidate of candidates) {
      if (seenHashes.has(candidate.source.contentHash)) {
        continue;
      }
      seenHashes.add(candidate.source.contentHash);
      included.push(candidate);
    }

    this.detectPackageManagerConflicts(included, config, warnings);

    const { markdown, sources } = this.render(included, warnings);
    return { instructionsMarkdown: markdown, sources, warnings };
  }

  /** Loads `.excalibur/instructions/*.md` as trusted project config sources. */
  private excaliburInstructionSources(repoRoot: string, workflowId?: string): CandidateSource[] {
    const dir = join(repoRoot, EXCALIBUR_DIR, 'instructions');
    const files = listFiles(dir).filter((name) => name.toLowerCase().endsWith('.md'));
    // general.md leads; the rest keep alphabetical order.
    files.sort((a, b) => {
      if (a === 'general.md') return -1;
      if (b === 'general.md') return 1;
      return a.localeCompare(b);
    });

    const candidates: CandidateSource[] = [];
    for (const fileName of files) {
      const content = readTextIfExists(join(dir, fileName));
      if (content === null || content.trim().length === 0) {
        continue;
      }
      const stem = fileName.replace(/\.md$/i, '');
      const isWorkflowSpecific = workflowId !== undefined && stem === workflowId;
      // Files named after other workflows are not part of this run's context.
      if (workflowId === undefined && this.looksWorkflowSpecific(stem)) {
        continue;
      }
      if (workflowId !== undefined && this.looksWorkflowSpecific(stem) && !isWorkflowSpecific) {
        continue;
      }
      const relPath = `${EXCALIBUR_DIR}/instructions/${fileName}`;
      candidates.push({
        precedence: isWorkflowSpecific ? 4 : 2,
        content,
        source: {
          id: `excalibur-${stem}`,
          scope: 'project',
          format: 'custom',
          kind: isWorkflowSpecific ? 'workflow_hint' : 'instruction',
          path: relPath,
          title: null,
          contentHash: sha256Hex(content),
          trustLevel: 'trusted',
          enabled: true,
          importedAs: 'instruction',
          metadata: { absolutePath: join(dir, fileName) },
        },
      });
    }
    return candidates;
  }

  /**
   * Maps caller-supplied repo-context into precedence-6 candidate sources.
   * Empty/whitespace content is dropped. The stable `id` keeps dedupe and
   * snapshot ordering deterministic; the `contentHash` lets identical injected
   * content dedupe against an instruction file with the same body.
   */
  private additionalContextSources(
    additional: AdditionalContextSource[] | undefined,
  ): CandidateSource[] {
    if (additional === undefined || additional.length === 0) {
      return [];
    }
    const candidates: CandidateSource[] = [];
    let index = 0;
    for (const entry of additional) {
      if (entry.content.trim().length === 0) {
        continue;
      }
      const id = `repo-context-${index}`;
      index += 1;
      candidates.push({
        precedence: entry.precedence ?? 6,
        content: entry.content,
        source: {
          id,
          scope: 'project',
          format: 'custom',
          kind: 'context',
          path: entry.path,
          title: entry.title ?? null,
          contentHash: sha256Hex(entry.content),
          trustLevel: 'trusted',
          enabled: true,
          importedAs: 'context',
          metadata: { repoContext: true },
        },
      });
    }
    return candidates;
  }

  /** A `.excalibur/instructions/<stem>.md` file matching a workflow id shape. */
  private looksWorkflowSpecific(stem: string): boolean {
    const workflowIds = new Set([
      'ask-repo',
      'review-only',
      'assist',
      'propose-patch',
      'fast-fix',
      'standard-feature',
      'structured-feature',
      'safe-refactor',
      'pr-review',
      'security-review',
      'migration',
      'explore-alternatives',
      'human-gated',
      'discovery',
    ]);
    return workflowIds.has(stem);
  }

  private classifyScanned(
    source: InstructionSource,
    config: ExcaliburConfig,
    input: EffectiveInstructionsInput,
    repoRoot: string,
    includeUserGlobal: boolean,
  ): CandidateSource | null {
    const override = this.configOverrideFor(source, config);
    const enabled = override?.enabled ?? source.enabled;
    const trustLevel = override?.trustLevel ?? source.trustLevel;

    if (source.kind === 'skill') {
      // Skills: only explicitly enabled AND trusted skills enter the context.
      // review_required / untrusted skills are always excluded (ISD §8).
      const skillEnabled =
        enabled || (input.enabledSkills?.some((id) => source.id.includes(id)) ?? false);
      if (!skillEnabled || trustLevel !== 'trusted') {
        return null;
      }
      const content = this.contentOf(source, repoRoot);
      return content === null ? null : { source, content, precedence: 7 };
    }

    if (!enabled || trustLevel === 'untrusted') {
      return null;
    }

    if (source.scope === 'user_global') {
      if (!includeUserGlobal) {
        return null;
      }
      const content = this.contentOf(source, repoRoot);
      return content === null ? null : { source, content, precedence: 5 };
    }

    if (source.kind === 'context') {
      const content = this.contentOf(source, repoRoot);
      return content === null ? null : { source, content, precedence: 6 };
    }

    if (REPO_INSTRUCTION_FORMATS.has(source.format) || source.kind === 'instruction') {
      const content = this.contentOf(source, repoRoot);
      return content === null ? null : { source, content, precedence: 3 };
    }

    return null;
  }

  private configOverrideFor(
    source: InstructionSource,
    config: ExcaliburConfig,
  ): { enabled?: boolean; trustLevel?: InstructionSource['trustLevel'] } | null {
    const sourcePath = normalizeConfigPath(source.path);
    if (source.kind === 'skill') {
      for (const entry of config.skills?.sources ?? []) {
        if (normalizeConfigPath(entry.path) === sourcePath) {
          const override: { enabled?: boolean; trustLevel?: InstructionSource['trustLevel'] } = {};
          if (entry.enabled !== undefined) override.enabled = entry.enabled;
          if (entry.trustLevel !== undefined) override.trustLevel = entry.trustLevel;
          return override;
        }
      }
      return null;
    }
    for (const entry of config.instructions?.sources ?? []) {
      if (normalizeConfigPath(entry.path) === sourcePath) {
        return entry.enabled !== undefined ? { enabled: entry.enabled } : {};
      }
    }
    return null;
  }

  private contentOf(source: InstructionSource, repoRoot: string): string | null {
    const absolutePath = absolutePathOf(source, repoRoot);
    if (absolutePath === null) {
      return null;
    }
    const content = readTextIfExists(absolutePath);
    return content === null || content.trim().length === 0 ? null : content;
  }

  /**
   * Conflicts are never silently resolved (ISD spec §8): at minimum, flag
   * instruction files that use a different package manager than the detected
   * repository commands — the repository config wins by precedence.
   */
  private detectPackageManagerConflicts(
    included: CandidateSource[],
    config: ExcaliburConfig,
    warnings: string[],
  ): void {
    const configured = configuredPackageManager(config);
    if (configured === null) {
      return;
    }
    for (const candidate of included) {
      const mentioned = new Set<string>();
      for (const match of candidate.content.matchAll(PM_USAGE_PATTERN)) {
        const name = match[1];
        if (name !== undefined && name !== configured) {
          mentioned.add(name);
        }
      }
      for (const other of mentioned) {
        warnings.push(
          `Package-manager conflict: ${candidate.source.path} mentions "${other}" commands but the repository configuration uses "${configured}" — the repository config wins by precedence.`,
        );
      }
    }
  }

  private render(
    included: CandidateSource[],
    warnings: string[],
  ): { markdown: string; sources: InstructionSource[] } {
    if (included.length === 0) {
      return { markdown: '', sources: [] };
    }

    const blocks: string[] = [];
    const sources: InstructionSource[] = [];
    let used = HEADER_LINE.length;
    const omitted: string[] = [];

    for (const candidate of included) {
      const header = headerFor(candidate.source);
      const redacted = redactSecrets(candidate.content.trim());
      const perSource = truncate(redacted, INSTRUCTION_SOURCE_CHAR_CAP);
      if (perSource.truncated) {
        warnings.push(
          `Instruction source ${candidate.source.path} exceeds the per-source cap (${INSTRUCTION_SOURCE_CHAR_CAP} chars) and was summarized.`,
        );
      }

      const block = `${header}\n\n${perSource.text}`;
      const remaining = INSTRUCTION_TOTAL_CHAR_CAP - used;
      if (block.length + 2 > remaining) {
        const room = remaining - header.length - SUMMARIZED_MARKER.length - 8;
        if (room > 200) {
          const fitted = `${header}\n\n${perSource.text.slice(0, room).trimEnd()}\n\n${SUMMARIZED_MARKER}`;
          blocks.push(fitted);
          sources.push(candidate.source);
          used += fitted.length + 2;
          warnings.push(
            `Total instruction context cap (${INSTRUCTION_TOTAL_CHAR_CAP} chars) reached at ${candidate.source.path}; content was summarized.`,
          );
        } else {
          omitted.push(candidate.source.path);
        }
        continue;
      }

      blocks.push(block);
      sources.push(candidate.source);
      used += block.length + 2;
    }

    if (omitted.length > 0) {
      warnings.push(
        `Total instruction context cap (${INSTRUCTION_TOTAL_CHAR_CAP} chars) reached; omitted sources: ${omitted.join(', ')}.`,
      );
    }

    const markdown = `${HEADER_LINE}\n\n${blocks.join('\n\n')}`;
    return { markdown, sources };
  }
}
