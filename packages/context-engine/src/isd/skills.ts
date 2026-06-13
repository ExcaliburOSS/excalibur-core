import * as YAML from 'yaml';
import type { DetectedSkill, InstructionSource } from '@excalibur/shared';
import { isRecord, readTextFile, slugify } from '../internal/fs-utils';
import type { ParsedSkillMd, ScanInstructionSourcesInput } from '../types';
import { scanInstructionSources } from './scan';

function toStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string | number => {
        return typeof entry === 'string' || typeof entry === 'number';
      })
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function firstString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function firstArray(data: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    if (data[key] !== undefined) {
      const values = toStringArray(data[key]);
      if (values.length > 0) {
        return values;
      }
    }
  }
  return [];
}

function parseFrontMatter(content: string): { data: Record<string, unknown> | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { data: null, body: content };
  }
  const body = content.slice(match[0].length);
  try {
    const parsed: unknown = YAML.parse(match[1] ?? '');
    return { data: isRecord(parsed) ? parsed : null, body };
  } catch {
    // Malformed front matter degrades gracefully to markdown-only parsing.
    return { data: null, body };
  }
}

interface MarkdownSection {
  heading: string;
  body: string;
}

function splitSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const matches = [...markdown.matchAll(/^#{2,3}[ \t]+(.+?)[ \t]*$/gm)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    if (!match || match.index === undefined) {
      continue;
    }
    const start = match.index + match[0].length;
    const next = matches[i + 1];
    const end = next?.index ?? markdown.length;
    sections.push({
      heading: (match[1] ?? '').trim(),
      body: markdown.slice(start, end).trim(),
    });
  }
  return sections;
}

function bulletItems(sectionBody: string): string[] {
  return [...sectionBody.matchAll(/^[ \t]*[-*][ \t]+(.+?)[ \t]*$/gm)]
    .map((match) => (match[1] ?? '').trim())
    .filter((item) => item.length > 0);
}

function findSection(sections: MarkdownSection[], pattern: RegExp): MarkdownSection | undefined {
  return sections.find((section) => pattern.test(section.heading));
}

function firstParagraph(markdown: string): string | null {
  for (const block of markdown.split(/\r?\n[ \t]*\r?\n/)) {
    const line = block.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('-') || line.startsWith('*')) {
      continue;
    }
    return line.replace(/\s+/g, ' ');
  }
  return null;
}

/**
 * Parses a SKILL.md capability definition: YAML front matter first
 * (name/description/when-to-use/dependencies/tools), markdown headings as
 * fallback. Never throws — unparseable content yields `null`/empty fields
 * while the skill itself is still detected (ISD spec §2).
 */
export function parseSkillMd(content: string, path: string): ParsedSkillMd {
  const { data, body } = parseFrontMatter(content);
  const sections = splitSections(body);

  let name: string | null = null;
  let description: string | null = null;
  let triggers: string[] = [];
  let dependencies: string[] = [];
  let toolsRequired: string[] = [];

  if (data) {
    name = firstString(data, ['name', 'title']);
    description = firstString(data, ['description']);
    triggers = firstArray(data, ['when-to-use', 'whenToUse', 'when_to_use', 'triggers']);
    dependencies = firstArray(data, ['dependencies', 'requires']);
    toolsRequired = firstArray(data, ['tools', 'toolsRequired', 'tools-required', 'allowed-tools']);
  }

  const headingMatch = body.match(/^#[ \t]+(.+?)[ \t]*$/m);
  if (name === null) {
    name = headingMatch?.[1]?.trim() ?? null;
  }
  if (description === null) {
    const afterHeading = headingMatch
      ? body.slice((headingMatch.index ?? 0) + headingMatch[0].length)
      : body;
    description = firstParagraph(afterHeading);
  }
  if (triggers.length === 0) {
    const section = findSection(sections, /when[ -]to[ -]use|use this skill|^triggers?$/i);
    triggers = section ? bulletItems(section.body) : [];
  }
  if (dependencies.length === 0) {
    const section = findSection(sections, /dependenc|requires/i);
    dependencies = section ? bulletItems(section.body) : [];
  }
  if (toolsRequired.length === 0) {
    const section = findSection(sections, /tools/i);
    toolsRequired = section ? bulletItems(section.body) : [];
  }

  const instructionsSection = findSection(sections, /instructions|usage|how to/i);

  return {
    sourcePath: path,
    name,
    description,
    triggers,
    dependencies,
    toolsRequired,
    instructions: instructionsSection ? instructionsSection.body : null,
  };
}

function skillDirName(source: InstructionSource): string {
  const relPath =
    typeof source.metadata['relativePath'] === 'string'
      ? source.metadata['relativePath']
      : source.path;
  const segments = relPath.split('/');
  return segments.length >= 2 ? (segments[segments.length - 2] ?? 'skill') : 'skill';
}

/**
 * Materializes `DetectedSkill` entries from already-scanned skill_md
 * instruction sources, reading and parsing each SKILL.md.
 */
export async function skillsFromSources(
  sources: InstructionSource[],
): Promise<DetectedSkill[]> {
  const skills: DetectedSkill[] = [];
  for (const source of sources) {
    if (source.format !== 'skill_md') {
      continue;
    }
    const absolutePath =
      typeof source.metadata['absolutePath'] === 'string'
        ? source.metadata['absolutePath']
        : source.path;
    const content = (await readTextFile(absolutePath)) ?? '';
    const parsed = parseSkillMd(content, source.path);
    skills.push({
      id: source.id,
      // Graceful fallback: an unparseable SKILL.md is still a detected skill,
      // named after its directory.
      name: parsed.name ?? slugify(skillDirName(source)),
      path: source.path,
      scope: source.scope === 'user_global' ? 'user_global' : 'project',
      description: parsed.description,
      triggers: parsed.triggers,
      dependencies: parsed.dependencies,
      toolsRequired: parsed.toolsRequired,
      trustLevel: source.trustLevel,
      // Hard safety rule (ISD spec §3): skills are never auto-enabled.
      enabled: false,
      source,
    });
  }
  return skills;
}

/**
 * Detects SKILL.md capability definitions in the repository (and optionally
 * the user's home directory). Skills are detected and classified but never
 * auto-enabled; unreviewed skills default to `review_required`.
 */
export async function detectSkills(
  input: ScanInstructionSourcesInput,
): Promise<DetectedSkill[]> {
  const sources = await scanInstructionSources(input);
  return skillsFromSources(sources);
}
