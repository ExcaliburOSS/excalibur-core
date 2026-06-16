import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Per-session Docker sandbox (OSS spec §18, M3): runs a command inside an
 * ephemeral container so agentic execution is isolated from the host — a fenced
 * filesystem (only the repo is mounted), CPU/memory caps, a hard timeout, NO
 * network by default, and NO host environment/secrets passed in. The repo is
 * mounted read-write at `/work` so edits land in the real tree; everything else
 * (the host fs, env, network) is unreachable. Commands are still
 * permission-gated by the agent loop BEFORE they reach here — the sandbox is the
 * second line of defense (defense in depth).
 */

export interface SandboxLimits {
  /** Container image (must have `sh`). Defaults to a small Alpine. */
  image?: string;
  /** Memory cap in MiB (default 1024). */
  memoryMb?: number;
  /** CPU cap (default 2). */
  cpus?: number;
  /** Allow network (default false — `--network none`). */
  allowNetwork?: boolean;
  /** Hard wall-clock timeout in ms (default 120s). */
  timeoutMs?: number;
}

export interface SandboxRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the run was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
}

const DEFAULTS = {
  image: 'alpine:3',
  memoryMb: 1024,
  cpus: 2,
  timeoutMs: 120_000,
} as const;

/** True when a Docker daemon is reachable (so callers can fall back to host exec). */
export function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
  return result.status === 0;
}

/**
 * Builds the `docker run` argv for a sandboxed command. Pure (no I/O) so the
 * isolation flags are unit-tested: `--rm` (ephemeral), `--network none` unless
 * explicitly allowed, memory/cpu caps, repo mounted at `/work`, and `sh -c` as
 * the entrypoint. The host environment is NOT forwarded (no `-e`), so secrets
 * never enter the container.
 */
export function buildDockerArgs(
  repoRoot: string,
  command: string,
  containerName: string,
  limits: SandboxLimits = {},
): string[] {
  const image = limits.image ?? DEFAULTS.image;
  const memoryMb = limits.memoryMb ?? DEFAULTS.memoryMb;
  const cpus = limits.cpus ?? DEFAULTS.cpus;
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    limits.allowNetwork === true ? 'bridge' : 'none',
    '--memory',
    `${memoryMb}m`,
    '--memory-swap',
    `${memoryMb}m`, // no extra swap → the memory cap is real
    '--cpus',
    String(cpus),
    '--pids-limit',
    '512',
    '-v',
    `${repoRoot}:/work`,
    '-w',
    '/work',
    '--entrypoint',
    'sh',
    image,
    '-c',
    command,
  ];
}

/**
 * Runs `command` in an ephemeral Docker sandbox over `repoRoot`. Never throws on
 * a non-zero exit / timeout — those are returned as data. On timeout the
 * container is killed so it never lingers.
 */
export function runInDockerSandbox(
  repoRoot: string,
  command: string,
  limits: SandboxLimits = {},
): SandboxRunResult {
  const containerName = `excalibur-sbx-${process.pid}-${Math.abs(hashString(command + repoRoot))}`;
  const args = buildDockerArgs(repoRoot, command, containerName, limits);
  try {
    const stdout = execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: limits.timeoutMs ?? DEFAULTS.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '', timedOut: false };
  } catch (error) {
    const e = error as {
      status?: number | null;
      killed?: boolean;
      signal?: string | null;
      code?: string;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    if (timedOut) {
      // Kill the (still-running) container so it never lingers after the timeout.
      spawnSync('docker', ['kill', containerName], { stdio: 'ignore', timeout: 10_000 });
    }
    return {
      exitCode: typeof e.status === 'number' ? e.status : null,
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? '').toString(),
      timedOut,
    };
  }
}

/** A small stable hash for unique-ish container names. */
function hashString(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return hash;
}
