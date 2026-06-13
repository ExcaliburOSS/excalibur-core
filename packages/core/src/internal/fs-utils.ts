import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Internal filesystem helpers shared by the core stores and managers. */

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Writes a file, creating parent directories as needed. */
export function writeFileEnsured(filePath: string, content: string): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, content, 'utf8');
}

/** Appends a line (adding the trailing newline), creating parents as needed. */
export function appendLineEnsured(filePath: string, line: string): void {
  ensureDir(dirname(filePath));
  appendFileSync(filePath, `${line}\n`, 'utf8');
}

/** Reads a UTF-8 text file, returning `null` when it does not exist. */
export function readTextIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Lists the names of the immediate subdirectories of `dir` (sorted). */
export function listSubdirectories(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Lists the file names inside `dir` (non-recursive, sorted). */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

/** sha256 hex digest of a UTF-8 string. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Builds a `<prefix>_YYYYMMDD_HHMMSS` id from LOCAL time, matching the shared
 * `generateRunId` format (onboarding spec §7: `patch_…`, `int_…`, `disc_…`).
 */
export function timestampId(prefix: string, date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${prefix}_${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

/**
 * Atomically reserves a fresh `<prefix>_YYYYMMDD_HHMMSS` directory under
 * `parentDir`, returning its id and path. Uses an exclusive (non-recursive)
 * `mkdirSync`, which throws `EEXIST` if the directory already exists — so two
 * processes (or two same-second calls within one process) can never reserve
 * the same id, closing the check-then-write race that `existsSync` left open.
 * On collision the clock advances by whole seconds, so ids stay sortable.
 *
 * The leaf directory is created as a side effect of the reservation; callers
 * write their files straight into the returned `dir` (no extra `ensureDir`).
 */
export function reserveTimestampDir(
  parentDir: string,
  prefix: string,
  date: Date = new Date(),
): { id: string; dir: string } {
  ensureDir(parentDir);
  let candidateDate = date;
  for (;;) {
    const id = timestampId(prefix, candidateDate);
    const dir = join(parentDir, id);
    try {
      // Non-recursive mkdir is exclusive: it throws EEXIST atomically instead
      // of succeeding silently, which is what makes the reservation race-free.
      mkdirSync(dir);
      return { id, dir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        candidateDate = new Date(candidateDate.getTime() + 1000);
        continue;
      }
      throw error;
    }
  }
}

/** Type guard for plain objects (not arrays, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
