import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import fg from 'fast-glob';

/** Directories never scanned for instructions, patterns or docs. */
export const SCAN_IGNORE: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.excalibur/**',
];

/** Files larger than this are skipped by the ISD scanner (not instructions). */
export const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** Reads a UTF-8 text file; returns `null` when missing/unreadable/too large. */
export async function readTextFile(
  filePath: string,
  maxBytes: number = MAX_SCANNED_FILE_BYTES,
): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maxBytes) {
      return null;
    }
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Parses a JSON file leniently; returns `null` when missing or malformed. */
export async function readJsonFile(filePath: string): Promise<unknown | null> {
  const text = await readTextFile(filePath);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Globs repo-relative POSIX paths. Case-sensitive matching against real
 * directory entries (safe on case-insensitive filesystems), dotfiles
 * included, standard ignore list applied.
 */
export async function globFiles(
  cwd: string,
  patterns: string[],
  options?: { onlyDirectories?: boolean; deep?: number },
): Promise<string[]> {
  try {
    const entries = await fg(patterns, {
      cwd,
      dot: true,
      ignore: [...SCAN_IGNORE],
      onlyFiles: !options?.onlyDirectories,
      onlyDirectories: options?.onlyDirectories ?? false,
      deep: options?.deep,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    return entries.map(toPosixPath).sort();
  } catch {
    return [];
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lowercase, alphanumeric-and-dash slug for stable ids. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'item';
}

/** File name without its final extension: `docs/testing.md` → `testing`. */
export function fileStem(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Relative path without its final extension, slashes preserved. */
export function pathStem(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  const slash = relPath.lastIndexOf('/');
  return dot > slash ? relPath.slice(0, dot) : relPath;
}
