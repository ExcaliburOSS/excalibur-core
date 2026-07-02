import { execFileSync } from 'node:child_process';

/**
 * F1 — the memory-priming QUERY helpers, shared by the chat seed (agent-turn's
 * `memorySeed`) and the gated build pipeline. Moved out of agent-turn so the lib
 * layer can use them without a session↔lib import cycle. The audit found builds
 * were primed ONLY from typecheck-error paths — a type-clean repo never received
 * a single memory, making Knowledge Compounding silent exactly where it matters.
 */

/** Path-like tokens named in a task (`src/x.ts`, `dir/file`, `foo.json`). */
export function pathsFromText(text: string): string[] {
  const matches = text.match(/[\w@.-]+\/[\w./-]+|[\w-]+\.[a-zA-Z][a-zA-Z0-9]+/g) ?? [];
  return [...new Set(matches)].slice(0, 20);
}

/** Working-set files (`git diff --name-only HEAD`); [] on any failure. */
export function changedFiles(repoRoot: string): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 2000,
      // Discard the child's stderr — a commit-less repo makes `HEAD` invalid and
      // git prints "fatal: ambiguous argument 'HEAD'" to the inherited terminal.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** The working-set ∪ named-paths union — the standard memory-priming query. */
export function memoryQueryPaths(repoRoot: string, task: string): string[] {
  return [...new Set([...changedFiles(repoRoot), ...pathsFromText(task)])];
}
