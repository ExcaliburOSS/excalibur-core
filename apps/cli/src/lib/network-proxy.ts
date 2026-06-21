import { readFileSync } from 'node:fs';
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';
import type { NetworkTransportConfig } from '@excalibur/shared';

/**
 * Corporate proxy + custom-CA support (P0.2).
 *
 * Every outbound request in the process (web fetch, model gateway, MCP HTTP,
 * enterprise-sync) funnels through Node's global `fetch`, which ignores the
 * `HTTP(S)_PROXY` env vars. Installing ONE global undici dispatcher at startup
 * makes them all honor the proxy + a custom CA at once.
 *
 * Precedence: the standard env vars (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/
 * `NODE_EXTRA_CA_CERTS`) ALWAYS win; `config.network` only fills the gaps. When a
 * proxy is active, loopback (`localhost`/`127.0.0.1`/`::1`) is always added to the
 * no-proxy set so local infra (Ollama, a local SearXNG) is never proxied. Config
 * values are mirrored into `process.env` so spawned children (stdio MCP servers,
 * the Playwright browser) inherit the same proxy/CA.
 */

/** The resolved transport plan (pure; no IO, no global side effects). */
export interface NetworkPlan {
  /** A proxy will be installed (from env or config). */
  proxy: boolean;
  /** Effective proxy for http:// targets (env wins over config), if any. */
  httpProxy?: string;
  /** Effective proxy for https:// targets (env wins over config), if any. */
  httpsProxy?: string;
  /** Effective no-proxy list (loopback always added when a proxy is active). */
  noProxy?: string;
  /** Env vars to mirror into `process.env` (so children inherit). */
  envPatch: Record<string, string>;
  /** PEM bundle path to inject as an extra CA (config `tls.caFile`), or null. */
  caFile: string | null;
  /** `tls.rejectUnauthorized === false` — TLS verification disabled (insecure). */
  insecure: boolean;
  /** Human-readable notes (for `doctor` / debugging). */
  notes: string[];
}

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/**
 * Resolves the effective transport plan from config + env (env wins). Pure: it
 * neither reads files, mutates env, nor touches the global dispatcher.
 */
export function resolveNetworkPlan(
  network: NetworkTransportConfig | undefined,
  env: NodeJS.ProcessEnv,
): NetworkPlan {
  const notes: string[] = [];
  const envHttps = env.HTTPS_PROXY ?? env.https_proxy;
  const envHttp = env.HTTP_PROXY ?? env.http_proxy;
  const envNo = env.NO_PROXY ?? env.no_proxy;

  const httpsProxy = envHttps ?? network?.proxy?.https;
  const httpProxy = envHttp ?? network?.proxy?.http;
  const configuredNoProxy = envNo ?? network?.proxy?.noProxy;
  const proxy = httpsProxy !== undefined || httpProxy !== undefined;

  const envPatch: Record<string, string> = {};
  // Mirror config proxy values into env (only when the env var is unset).
  if (envHttps === undefined && network?.proxy?.https !== undefined) {
    envPatch.HTTPS_PROXY = network.proxy.https;
  }
  if (envHttp === undefined && network?.proxy?.http !== undefined) {
    envPatch.HTTP_PROXY = network.proxy.http;
  }

  let noProxy: string | undefined;
  if (proxy) {
    // Always bypass loopback so local infra (Ollama, local SearXNG) is direct;
    // merge with whatever the user/config asked to bypass.
    const bypass = new Set<string>(LOOPBACK);
    for (const host of (configuredNoProxy ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)) {
      bypass.add(host);
    }
    noProxy = [...bypass].join(',');
    envPatch.NO_PROXY = noProxy;
    notes.push(`proxy active (${httpsProxy ?? httpProxy}); no_proxy=${noProxy}`);
  }

  const caFile = network?.tls?.caFile ?? null;
  if (caFile !== null && env.NODE_EXTRA_CA_CERTS === undefined) {
    // Mirror to NODE_EXTRA_CA_CERTS so child processes pick it up too (this
    // process injects it via the dispatcher, since the env var is read at boot).
    envPatch.NODE_EXTRA_CA_CERTS = caFile;
    notes.push(`custom CA from config: ${caFile}`);
  } else if (env.NODE_EXTRA_CA_CERTS !== undefined) {
    notes.push(`custom CA from NODE_EXTRA_CA_CERTS: ${env.NODE_EXTRA_CA_CERTS}`);
  }

  const insecure = network?.tls?.rejectUnauthorized === false;
  if (insecure) {
    notes.push('TLS verification DISABLED (network.tls.rejectUnauthorized=false) — INSECURE');
  }

  return {
    proxy,
    ...(httpProxy !== undefined ? { httpProxy } : {}),
    ...(httpsProxy !== undefined ? { httpsProxy } : {}),
    ...(noProxy !== undefined ? { noProxy } : {}),
    envPatch,
    caFile,
    insecure,
    notes,
  };
}

/** Options for {@link installNetworkProxy} (all injectable for tests). */
export interface InstallNetworkProxyOptions {
  env?: NodeJS.ProcessEnv;
  apply?: (dispatcher: Dispatcher) => void;
  readFile?: (path: string) => string;
}

/** The outcome of {@link installNetworkProxy}. */
export interface InstallNetworkProxyResult extends NetworkPlan {
  /** Whether a global dispatcher was actually installed. */
  installed: boolean;
}

/**
 * Installs a process-global undici dispatcher honoring the proxy + custom CA, so
 * EVERY `fetch` (web/model/MCP/sync) routes through it. No-op (returns
 * `installed: false`) when there is no proxy and no custom CA/insecure flag —
 * `NODE_EXTRA_CA_CERTS` set in the environment still works natively via Node.
 */
export function installNetworkProxy(
  network: NetworkTransportConfig | undefined,
  options: InstallNetworkProxyOptions = {},
): InstallNetworkProxyResult {
  const env = options.env ?? process.env;
  const apply = options.apply ?? setGlobalDispatcher;
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));

  const plan = resolveNetworkPlan(network, env);

  // Mirror resolved values into env BEFORE constructing the agent (EnvHttpProxyAgent
  // reads env) and so spawned children inherit them.
  for (const [key, value] of Object.entries(plan.envPatch)) {
    env[key] = value;
  }

  let ca: string | undefined;
  if (plan.caFile !== null) {
    try {
      ca = readFile(plan.caFile);
    } catch (error) {
      plan.notes.push(
        `failed to read network.tls.caFile "${plan.caFile}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const connect: Record<string, unknown> = {};
  if (ca !== undefined) {
    connect.ca = ca;
  }
  if (plan.insecure) {
    connect.rejectUnauthorized = false;
  }
  const hasConnect = Object.keys(connect).length > 0;

  if (plan.proxy) {
    // Pass the resolved proxy values EXPLICITLY (don't rely on the agent reading
    // process.env) so a config-only proxy works and the install is deterministic.
    apply(
      new EnvHttpProxyAgent({
        ...(plan.httpProxy !== undefined ? { httpProxy: plan.httpProxy } : {}),
        ...(plan.httpsProxy !== undefined ? { httpsProxy: plan.httpsProxy } : {}),
        ...(plan.noProxy !== undefined ? { noProxy: plan.noProxy } : {}),
        ...(hasConnect ? { connect } : {}),
      }),
    );
    return { ...plan, installed: true };
  }
  if (hasConnect) {
    apply(new Agent({ connect }));
    return { ...plan, installed: true };
  }
  return { ...plan, installed: false };
}
