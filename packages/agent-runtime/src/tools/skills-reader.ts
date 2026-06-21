import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Self-contained skill reader for the model-callable `skill` tool (P1.8b).
 *
 * "Skills" are `SKILL.md` files (Claude-skill convention) discovered under a
 * few well-known base dirs (`skills/`, `.skills/`, `.claude/skills/`) in the
 * project (and the user-global config). Each has YAML front matter (`name`,
 * `description`) and a markdown body of full instructions.
 *
 * This is PROGRESSIVE DISCLOSURE: the agent is told only the skill NAMES +
 * one-line descriptions up front (cheap), and pulls a skill's full body ON
 * DEMAND via the `skill` tool when it decides the skill is relevant. That is a
 * deliberate pull by the model — distinct from auto-enabling a skill into every
 * prompt (which Excalibur never does).
 *
 * Kept dependency-free (no context-engine import) so the agent-runtime package
 * stays self-contained; it re-implements only the tiny scan+parse it needs.
 */

/** One discovered skill (metadata only — the body is read lazily by name). */
export interface SkillEntry {
  /** Skill name (front-matter `name`, else the containing directory name). */
  name: string;
  /** One-line description (front-matter `description`, else first body line). */
  description: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
}

/** Base directories (relative to a root) that may contain `<skill>/SKILL.md`. */
const SKILL_BASE_DIRS = ['skills', '.skills', '.claude/skills'] as const;
/** Bounded recursion so a pathological tree can never hang the scan. */
const MAX_DEPTH = 4;

function splitFrontMatter(content: string): { meta: Record<string, string>; body: string } {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (match === null) {
    return { meta: {}, body: normalized.trim() };
  }
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv !== null) {
      meta[kv[1] as string] = (kv[2] ?? '').replace(/^["']|["']$/g, '').trim();
    }
  }
  return { meta, body: (match[2] ?? '').trim() };
}

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 160);
}

/** Recursively collects SKILL.md paths under `dir` (depth-bounded). */
function findSkillFiles(dir: string, depth: number, into: string[]): void {
  if (depth > MAX_DEPTH || !existsSync(dir)) {
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      findSkillFiles(abs, depth + 1, into);
    } else if (entry === 'SKILL.md') {
      into.push(abs);
    }
  }
}

/** Parses one SKILL.md path into a {@link SkillEntry} (name falls back to its dir). */
export function parseSkillFile(path: string): SkillEntry | null {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = splitFrontMatter(content);
  const dirName = basename(dirname(path));
  const name = (meta['name'] !== undefined && meta['name'].length > 0 ? meta['name'] : dirName)
    .toLowerCase()
    .trim();
  if (name.length === 0) {
    return null;
  }
  const description =
    meta['description'] !== undefined && meta['description'].length > 0
      ? meta['description']
      : firstLine(body);
  return { name, description, path };
}

/**
 * Scans the given roots for skills. Earlier roots win on a name clash (callers
 * pass project root first, then the user-global dir), mirroring the
 * project-overrides-global precedence used elsewhere.
 */
export function loadSkillIndex(roots: ReadonlyArray<string>): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  // Scan in REVERSE so earlier roots (project) overwrite later ones (global).
  for (const root of [...roots].reverse()) {
    for (const base of SKILL_BASE_DIRS) {
      const files: string[] = [];
      findSkillFiles(join(root, base), 0, files);
      for (const file of files) {
        const skill = parseSkillFile(file);
        if (skill !== null) {
          byName.set(skill.name, skill);
        }
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads a skill's full instruction body (front matter stripped). */
export function readSkillBody(path: string): string {
  return splitFrontMatter(readFileSync(path, 'utf8')).body;
}
