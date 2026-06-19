/**
 * Test-only helpers (imported exclusively from *.test.ts files; not part of
 * the public API and not reachable from src/index.ts).
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Walks up from `start` to the pnpm monorepo root (pnpm-workspace.yaml). */
export function findMonorepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`pnpm-workspace.yaml not found above ${start}`);
    }
    dir = parent;
  }
}

export function demoRepoDir(): string {
  return path.join(findMonorepoRoot(), 'examples', 'demo-repo');
}

/** Creates a unique temp directory and registers files into it. */
export async function makeFixtureDir(files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'excalibur-ctx-'));
  await writeFixtureFiles(dir, files);
  return dir;
}

export async function writeFixtureFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(dir, ...relPath.split('/'));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }
}

export async function removeFixtureDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
