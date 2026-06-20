import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDockerAvailable } from '../../sandbox/docker-sandbox';
import type { FetchImpl } from './fetch';

/**
 * Local SearXNG lifecycle (F3) — Excalibur AUTO-PROVISIONS a private, unlimited
 * metasearch backend by managing a `searxng/searxng` Docker container, reusing
 * the same Docker plumbing as the run sandbox. This makes SearXNG the default
 * `web_search` backend with ZERO user configuration whenever Docker is present;
 * without Docker, search transparently falls back to keyless DuckDuckGo.
 *
 * The container is bound to LOOPBACK only (`127.0.0.1`), runs with the bot
 * `limiter` disabled (so our JSON queries aren't throttled), and is configured
 * (via a generated `settings.yml`) to expose the JSON API the resolver needs.
 * The generated secret key is persisted so restarts reuse it.
 *
 * The Docker calls are synchronous (mirroring docker-sandbox.ts); only the
 * readiness probe is async (it polls the HTTP endpoint).
 */

export const SEARXNG_IMAGE = 'searxng/searxng:latest';
export const SEARXNG_CONTAINER = 'excalibur-searxng';
/** Host port (loopback) → container 8080. Avoids clashing with a user's 8888. */
export const SEARXNG_DEFAULT_PORT = 8899;

export interface SearxngManagerOptions {
  /** Base URL of the instance (default `http://127.0.0.1:<port>`). */
  baseUrl?: string;
  /** Host port to bind (default {@link SEARXNG_DEFAULT_PORT}). */
  port?: number;
  /** Directory holding the generated `settings.yml` (default ~/.config/excalibur/searxng). */
  configDir?: string;
  /** Injectable fetch for the readiness probe (tests pass a fake). */
  fetchImpl?: FetchImpl;
  /** Probe/readiness timeout budget in ms (default 1500 for probe, 60000 for boot). */
  timeoutMs?: number;
}

export type SearxngContainerState = 'running' | 'exited' | 'absent' | 'docker-unavailable';

/** The loopback base URL for a given host port. */
export function searxngBaseUrl(port: number = SEARXNG_DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}`;
}

function resolveBaseUrl(opts: SearxngManagerOptions): string {
  return opts.baseUrl ?? searxngBaseUrl(opts.port ?? SEARXNG_DEFAULT_PORT);
}

function resolveConfigDir(opts: SearxngManagerOptions): string {
  return opts.configDir ?? join(homedir(), '.config', 'excalibur', 'searxng');
}

/**
 * Probes a SearXNG instance: confirms it answers AND has the JSON format enabled
 * (a plain HTML-only instance is useless to the resolver). Never throws.
 */
export async function searxngReachable(opts: SearxngManagerOptions = {}): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const base = resolveBaseUrl(opts);
  const url = new URL('/search', base);
  url.searchParams.set('q', 'excalibur');
  url.searchParams.set('format', 'json');
  try {
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { results?: unknown };
    return Array.isArray(payload.results);
  } catch {
    return false;
  }
}

/** Inspects our managed container's state (or reports Docker missing). Never throws. */
export function searxngContainerState(): SearxngContainerState {
  if (!isDockerAvailable()) return 'docker-unavailable';
  const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', SEARXNG_CONTAINER], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return 'absent';
  return result.stdout.trim() === 'true' ? 'running' : 'exited';
}

/** Writes the generated `settings.yml` (idempotent — keeps an existing secret key). */
function ensureSettings(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  const settingsPath = join(configDir, 'settings.yml');
  if (existsSync(settingsPath)) return;
  const secret = randomBytes(32).toString('hex');
  const settings = [
    'use_default_settings: true',
    'server:',
    `  secret_key: "${secret}"`,
    '  limiter: false',
    '  image_proxy: false',
    'search:',
    '  safe_search: 0',
    '  formats:',
    '    - html',
    '    - json',
    '',
  ].join('\n');
  writeFileSync(settingsPath, settings, { mode: 0o600 });
}

/** Polls the readiness probe until reachable or the deadline passes. */
async function waitUntilReachable(
  opts: SearxngManagerOptions,
  deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await searxngReachable({ ...opts, timeoutMs: 1500 })) return true;
    if (Date.now() - start > deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export interface ProvisionResult {
  ok: boolean;
  baseUrl: string;
  /** Human-readable status (for the CLI). */
  message: string;
}

/**
 * Provisions a local SearXNG: pulls the image if needed, generates settings,
 * (re)creates and starts the container, then waits until it answers JSON.
 * Caller is responsible for any consent prompt. Returns a structured result
 * rather than throwing, so the CLI can present a clean message.
 */
export async function provisionSearxng(opts: SearxngManagerOptions = {}): Promise<ProvisionResult> {
  const baseUrl = resolveBaseUrl(opts);
  const port = opts.port ?? SEARXNG_DEFAULT_PORT;
  const configDir = resolveConfigDir(opts);
  if (!isDockerAvailable()) {
    return {
      ok: false,
      baseUrl,
      message: 'Docker is not available; cannot provision a local SearXNG.',
    };
  }
  // Already running → nothing to do.
  if (searxngContainerState() === 'running' && (await searxngReachable({ ...opts, baseUrl }))) {
    return { ok: true, baseUrl, message: `SearXNG already running at ${baseUrl}.` };
  }
  ensureSettings(configDir);
  // Remove any stale container (exited or mid-recreate) so `run` won't conflict.
  spawnSync('docker', ['rm', '-f', SEARXNG_CONTAINER], { stdio: 'ignore', timeout: 30_000 });
  try {
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--name',
        SEARXNG_CONTAINER,
        '--restart',
        'unless-stopped',
        '-p',
        `127.0.0.1:${port}:8080`,
        '-v',
        `${configDir}:/etc/searxng`,
        SEARXNG_IMAGE,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
    );
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    return {
      ok: false,
      baseUrl,
      message: `Failed to start the SearXNG container: ${(stderr ?? '').toString().trim() || 'unknown error'}`,
    };
  }
  const ready = await waitUntilReachable({ ...opts, baseUrl }, opts.timeoutMs ?? 60_000);
  return ready
    ? { ok: true, baseUrl, message: `SearXNG is up at ${baseUrl}.` }
    : {
        ok: false,
        baseUrl,
        message: `SearXNG started but did not become ready in time (${baseUrl}).`,
      };
}

/** Stops and removes the managed container. Returns true if it acted. */
export function removeSearxng(): boolean {
  if (!isDockerAvailable()) return false;
  const result = spawnSync('docker', ['rm', '-f', SEARXNG_CONTAINER], {
    stdio: 'ignore',
    timeout: 30_000,
  });
  return result.status === 0;
}

/**
 * Resolves a reachable local SearXNG WITHOUT provisioning (the agent's fast
 * path): if an instance already answers, returns its URL; if our container
 * merely needs starting and `autoStart` is on, starts it and waits briefly;
 * otherwise returns null so the caller falls back to DuckDuckGo. Never pulls or
 * creates a container here (that is `provisionSearxng`, driven by the CLI).
 */
export async function resolveLocalSearxng(
  opts: SearxngManagerOptions & { autoStart?: boolean } = {},
): Promise<string | null> {
  const baseUrl = resolveBaseUrl(opts);
  if (await searxngReachable({ ...opts, baseUrl })) {
    return baseUrl;
  }
  if (opts.autoStart !== true) {
    return null;
  }
  if (searxngContainerState() !== 'exited') {
    return null;
  }
  const started = spawnSync('docker', ['start', SEARXNG_CONTAINER], {
    stdio: 'ignore',
    timeout: 30_000,
  });
  if (started.status !== 0) {
    return null;
  }
  // Bounded wait so an agent turn never hangs on a slow boot.
  const ready = await waitUntilReachable({ ...opts, baseUrl }, 15_000);
  return ready ? baseUrl : null;
}
