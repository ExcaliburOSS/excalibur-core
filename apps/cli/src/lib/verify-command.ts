import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The outcome of a configured verification command (test/typecheck). */
export interface VerifyCommandResult {
  passed: boolean;
  /** Human-readable proof when passed, or the first failure line otherwise. */
  detail: string;
}

/**
 * Builds a deterministic ground-truth check from a repo command (e.g. the test
 * or typecheck command). Runs it with NO shell (split on whitespace), an
 * optional abort signal, and a hard timeout; exit 0 → passed. Returns undefined
 * when no command is configured. Shared by the goal loop's done-gate (AO3d) and
 * the swarm's verified fan-in (AO4b) so both reuse one runner.
 */
export function runConfiguredCommandCheck(
  repoRoot: string,
  command: string | undefined,
  signal: AbortSignal | undefined,
): (() => Promise<VerifyCommandResult>) | undefined {
  const trimmed = command?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  const [bin, ...args] = trimmed.split(/\s+/);
  return async () => {
    try {
      await execFileAsync(bin ?? '', args, {
        cwd: repoRoot,
        ...(signal !== undefined ? { signal } : {}),
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { passed: true, detail: `\`${trimmed}\` passed` };
    } catch (error) {
      const first = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
      return { passed: false, detail: `\`${trimmed}\` failed: ${first.slice(0, 140)}` };
    }
  };
}
