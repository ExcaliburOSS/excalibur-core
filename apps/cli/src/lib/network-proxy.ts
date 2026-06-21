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
 * TRUST MODEL (security — adversarial review P0.2):
 *  - **Env vars are trusted** (operator-set): `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`/
 *    `NODE_EXTRA_CA_CERTS`. Always honored. Env ALWAYS wins over config.
 *  - The repo-committed `.excalibur/config.yaml` `network.*` section is **UNTRUSTED**:
 *    a cloned malicious repo must not be able to redirect ALL egress (including
 *    model calls that carry API keys) through an attacker proxy, nor disable TLS,
 *    nor trust an attacker CA. Repo `network.*` is honored ONLY when the operator
 *    opts in with `EXCALIBUR_TRUST_REPO_NETWORK=1`; otherwise it is ignored (noted).
 *
 * Other guarantees: loopback (`localhost`/`127.0.0.1`/`::1`) is always added to the
 * no-proxy set so local infra (Ollama, a local SearXNG) is never proxied; a single
 * configured proxy covers BOTH schemes (matching undici) and is mirrored to env for
 * both so spawned children route identically; proxy URLs are scheme-validated
 * (http/https only) and credential-redacted in notes; under a proxy the per-IP SSRF
 * DNS-rebinding re-check cannot apply (the proxy resolves), so a note advises relying
 * on the `permissions.network` allowlist.
 */

/** The resolved transport plan (pure; no IO, no global side effects). */
export interface NetworkPlan {
  proxy: boolean;
  /** Effective proxy for http:// targets (validated; env wins over trusted config). */
  httpProxy?: string;
  /** Effective proxy for https:// targets. */
  httpsProxy?: string;
  /** Effective no-proxy list (loopback always added when a proxy is active). */
  noProxy?: string;
  /** Env vars to mirror into `process.env` (so children inherit). */
  envPatch: Record<string, string>;
  /** PEM bundle path to inject as an extra CA, or null (env CA wins). */
  caFile: string | null;
  /** `tls.rejectUnauthorized === false` — TLS verification disabled (insecure). */
  insecure: boolean;
  /** Human-readable notes (for `doctor` / debugging; credentials redacted). */
  notes: string[];
}

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

/** Trims a value; empty/whitespace → undefined (so `HTTPS_PROXY=` or `https:''` is "unset"). */
function clean(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Validates a proxy URL: must parse and be http/https. Returns {url} or {error}. */
function validProxyUrl(value: string | undefined): { url?: string; error?: string } {
  const cleaned = clean(value);
  if (cleaned === undefined) {
    return {};
  }
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return { error: `ignored invalid proxy URL "${redactProxyUrl(cleaned)}"` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      error: `ignored proxy with unsupported scheme "${parsed.protocol}" (only http/https)`,
    };
  }
  return { url: cleaned };
}

/** Masks inline credentials in a proxy URL for logs (`http://u:p@h` → `http://***@h`). */
export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      parsed.username = '***';
      parsed.password = '';
      return parsed.toString();
    }
    return url;
  } catch {
    return url.replace(/\/\/[^/@]*@/, '//***@');
  }
}

/**
 * Resolves the effective transport plan from config + env (env wins; repo config
 * gated behind `EXCALIBUR_TRUST_REPO_NETWORK`). Pure: no IO, no env mutation, no
 * global dispatcher change.
 */
export function resolveNetworkPlan(
  network: NetworkTransportConfig | undefined,
  env: NodeJS.ProcessEnv,
): NetworkPlan {
  const notes: string[] = [];

  // Repo config is untrusted unless the operator opts in (clone-a-repo egress hijack).
  const trustRepo = isTruthyEnv(env.EXCALIBUR_TRUST_REPO_NETWORK);
  const cfg = trustRepo ? network : undefined;
  if (network !== undefined && !trustRepo) {
    notes.push(
      'repo .excalibur/config.yaml network.* IGNORED for safety — set EXCALIBUR_TRUST_REPO_NETWORK=1 to honor it (an untrusted repo could otherwise redirect egress, incl. API-key-bearing model calls).',
    );
  }

  const envHttps = clean(env.HTTPS_PROXY ?? env.https_proxy);
  const envHttp = clean(env.HTTP_PROXY ?? env.http_proxy);
  const envNo = clean(env.NO_PROXY ?? env.no_proxy);

  const httpsResolved = validProxyUrl(envHttps ?? cfg?.proxy?.https);
  const httpResolved = validProxyUrl(envHttp ?? cfg?.proxy?.http);
  if (httpsResolved.error !== undefined) notes.push(httpsResolved.error);
  if (httpResolved.error !== undefined) notes.push(httpResolved.error);

  let httpsProxy = httpsResolved.url;
  let httpProxy = httpResolved.url;
  // A single configured proxy covers BOTH schemes (matches undici's fallback).
  if (httpsProxy === undefined && httpProxy !== undefined) httpsProxy = httpProxy;
  if (httpProxy === undefined && httpsProxy !== undefined) httpProxy = httpsProxy;
  const proxy = httpProxy !== undefined || httpsProxy !== undefined;

  const envPatch: Record<string, string> = {};
  let noProxy: string | undefined;
  if (proxy) {
    // Mirror BOTH schemes to env (for children) only where the env var is unset.
    if (
      env.HTTPS_PROXY === undefined &&
      env.https_proxy === undefined &&
      httpsProxy !== undefined
    ) {
      envPatch.HTTPS_PROXY = httpsProxy;
    }
    if (env.HTTP_PROXY === undefined && env.http_proxy === undefined && httpProxy !== undefined) {
      envPatch.HTTP_PROXY = httpProxy;
    }
    const bypass = new Set<string>(LOOPBACK);
    for (const host of (envNo ?? cfg?.proxy?.noProxy ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean)) {
      bypass.add(host);
    }
    noProxy = [...bypass].join(',');
    envPatch.NO_PROXY = noProxy;
    notes.push(
      `proxy active (${redactProxyUrl(httpsProxy ?? (httpProxy as string))}); no_proxy=${noProxy}`,
    );
    notes.push(
      'proxy active → per-IP SSRF DNS-rebinding re-check is bypassed (the proxy resolves the target); rely on permissions.network allowlist for egress control.',
    );
  }

  // Custom CA: env NODE_EXTRA_CA_CERTS WINS (Node reads it natively at boot). Only
  // inject a config CA (for this process via the dispatcher) when env is unset.
  let caFile: string | null = null;
  if (env.NODE_EXTRA_CA_CERTS !== undefined) {
    notes.push(`custom CA from NODE_EXTRA_CA_CERTS: ${env.NODE_EXTRA_CA_CERTS}`);
  } else if (cfg?.tls?.caFile !== undefined) {
    caFile = cfg.tls.caFile;
    envPatch.NODE_EXTRA_CA_CERTS = caFile; // children read it natively at their boot
    notes.push(`custom CA from config: ${caFile}`);
  }

  const insecure = cfg?.tls?.rejectUnauthorized === false;
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
  installed: boolean;
}

/**
 * Installs a process-global undici dispatcher honoring the proxy + custom CA, so
 * EVERY `fetch` (web/model/MCP/sync) routes through it. No-op when there is no
 * proxy and no custom CA/insecure flag (`NODE_EXTRA_CA_CERTS` in env still works
 * natively via Node).
 */
export function installNetworkProxy(
  network: NetworkTransportConfig | undefined,
  options: InstallNetworkProxyOptions = {},
): InstallNetworkProxyResult {
  const env = options.env ?? process.env;
  const apply = options.apply ?? setGlobalDispatcher;
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));

  const plan = resolveNetworkPlan(network, env);

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

  const tls: Record<string, unknown> = {};
  if (ca !== undefined) tls.ca = ca;
  if (plan.insecure) tls.rejectUnauthorized = false;
  const hasTls = Object.keys(tls).length > 0;

  if (plan.proxy) {
    // undici's ProxyAgent reads TLS from requestTls (origin leg) + proxyTls (proxy
    // leg), NOT from `connect` (proxy-agent.js:134-135) — passing `connect` here is
    // silently dropped. Map our CA/insecure into BOTH legs so a corporate CA on the
    // target AND on an https proxy endpoint are honored.
    apply(
      new EnvHttpProxyAgent({
        ...(plan.httpProxy !== undefined ? { httpProxy: plan.httpProxy } : {}),
        ...(plan.httpsProxy !== undefined ? { httpsProxy: plan.httpsProxy } : {}),
        ...(plan.noProxy !== undefined ? { noProxy: plan.noProxy } : {}),
        ...(hasTls ? { requestTls: tls, proxyTls: tls } : {}),
      }),
    );
    return { ...plan, installed: true };
  }
  if (hasTls) {
    apply(new Agent({ connect: tls }));
    return { ...plan, installed: true };
  }
  return { ...plan, installed: false };
}
