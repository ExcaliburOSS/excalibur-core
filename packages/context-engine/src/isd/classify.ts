import type { InstructionSourceFormat, InstructionSourceScope } from '@excalibur/shared';
import { fileStem, pathStem, slugify } from '../internal/fs-utils';

/** Stable ordering of formats in scanner output. */
export const FORMAT_ORDER: ReadonlyArray<InstructionSourceFormat> = [
  'claude_md',
  'agents_md',
  'cursor_rules',
  'copilot_instructions',
  'gemini_md',
  'codex',
  'aider',
  'skill_md',
  'docs',
  'adr',
  'custom',
];

/** Text-like extensions the directory-wide globs are allowed to pick up. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.mdc',
  '.markdown',
  '.txt',
  '.yml',
  '.yaml',
]);

const ADR_SEGMENTS: ReadonlySet<string> = new Set(['adr', 'adrs', 'decisions']);

export function hasTextExtension(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    // Extensionless dotfiles such as `.aiderignore` are classified explicitly.
    return base === '.aiderignore';
  }
  return TEXT_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

function isSkillFile(relPath: string): boolean {
  if ((relPath.split('/').pop() ?? '') !== 'SKILL.md') {
    return false;
  }
  return (
    relPath.startsWith('skills/') ||
    relPath.startsWith('.skills/') ||
    relPath.startsWith('.claude/skills/')
  );
}

/**
 * Classifies a repo-relative (or home-relative) path into an
 * `InstructionSourceFormat` per instructions-skills-core.md §1.
 * Returns `null` for files that are not instruction sources.
 */
export function classifySourcePath(
  relPath: string,
  scope: InstructionSourceScope,
): InstructionSourceFormat | null {
  if (!hasTextExtension(relPath)) {
    return null;
  }
  if (isSkillFile(relPath)) {
    return 'skill_md';
  }
  if (scope === 'user_global') {
    // User-global scanning is limited to ~/.claude/** in M1.
    return relPath === '.claude/CLAUDE.md' || relPath.startsWith('.claude/')
      ? 'claude_md'
      : null;
  }
  if (relPath === 'CLAUDE.md' || relPath.startsWith('.claude/')) {
    return 'claude_md';
  }
  if (relPath === 'AGENTS.md') {
    return 'agents_md';
  }
  if (relPath === 'GEMINI.md') {
    return 'gemini_md';
  }
  if (relPath === '.cursor/rules.md' || relPath.startsWith('.cursor/rules/')) {
    return 'cursor_rules';
  }
  if (relPath === '.github/copilot-instructions.md') {
    return 'copilot_instructions';
  }
  if (relPath.startsWith('.codex/') || relPath.startsWith('.openai/')) {
    return 'codex';
  }
  if (relPath === '.aider.conf.yml' || relPath === '.aiderignore') {
    return 'aider';
  }
  if (relPath.startsWith('.windsurf/') || relPath.startsWith('.continue/')) {
    return 'custom';
  }
  const segments = relPath.split('/');
  if (segments.slice(0, -1).some((segment) => ADR_SEGMENTS.has(segment.toLowerCase()))) {
    return 'adr';
  }
  if (
    relPath === 'README.md' ||
    relPath === 'CONTRIBUTING.md' ||
    relPath.startsWith('docs/')
  ) {
    return 'docs';
  }
  return null;
}

/** Base id before collision suffixing — stable, human-readable (contract §4.5). */
function baseId(
  format: InstructionSourceFormat,
  scope: InstructionSourceScope,
  relPath: string,
): string {
  const globalSuffix = scope === 'user_global' ? '-global' : '';
  switch (format) {
    case 'claude_md': {
      if (scope === 'project' && relPath === 'CLAUDE.md') {
        return 'claude-project';
      }
      if (scope === 'user_global' && relPath === '.claude/CLAUDE.md') {
        return 'claude-global';
      }
      const stripped = pathStem(relPath).replace(/^\.claude\//, '');
      return `claude-${slugify(stripped)}${globalSuffix}`;
    }
    case 'skill_md': {
      const segments = relPath.split('/');
      const skillDir = segments.length >= 2 ? (segments[segments.length - 2] ?? 'skill') : 'skill';
      return `skill-${slugify(skillDir)}${globalSuffix}`;
    }
    case 'agents_md':
      return 'agents-project';
    case 'gemini_md':
      return 'gemini-project';
    case 'copilot_instructions':
      return 'copilot-project';
    case 'cursor_rules':
      return relPath === '.cursor/rules.md' ? 'cursor-rules' : `cursor-${slugify(fileStem(relPath))}`;
    case 'codex':
      return `codex-${slugify(fileStem(relPath))}`;
    case 'aider':
      return relPath === '.aiderignore' ? 'aider-ignore' : 'aider-conf';
    case 'docs': {
      if (relPath === 'README.md') {
        return 'docs-readme';
      }
      if (relPath === 'CONTRIBUTING.md') {
        return 'docs-contributing';
      }
      return `docs-${slugify(pathStem(relPath).replace(/^docs\//, ''))}`;
    }
    case 'adr':
      return `adr-${slugify(fileStem(relPath))}`;
    case 'custom':
      return `custom-${slugify(pathStem(relPath))}${globalSuffix}`;
  }
}

/** Generates a unique stable id, suffixing `-2`, `-3`, … on collision. */
export function makeSourceId(
  format: InstructionSourceFormat,
  scope: InstructionSourceScope,
  relPath: string,
  used: Set<string>,
): string {
  const base = baseId(format, scope, relPath);
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Extracts a title from YAML front matter (`name`/`title`) or the first H1. */
export function extractTitle(content: string): string | null {
  const frontMatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontMatter) {
    const nameLine = frontMatter[1]?.match(/^(?:name|title):[ \t]*(['"]?)(.+?)\1[ \t]*$/m);
    const value = nameLine?.[2]?.trim();
    if (value) {
      return value;
    }
  }
  const heading = content.match(/^#[ \t]+(.+?)[ \t]*$/m);
  const headingText = heading?.[1]?.trim();
  return headingText && headingText.length > 0 ? headingText : null;
}
