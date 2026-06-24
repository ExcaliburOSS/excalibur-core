import type { CliDeps } from '../deps';
import { loadGatewayContext } from './context';

/**
 * Best-effort check that the configured model ids still exist on the provider —
 * the catalog pins ids that churn, so a stale `good`/`fast`/subscription model
 * would otherwise only surface later as a confusing runtime error. We list the
 * provider's models (`/v1/models`) and WARN (never block) when a configured id
 * isn't there. Networked, timed-out, and fully swallowed on any failure.
 */

const RESERVED = new Set(['default', 'cheap']);
const LIST_TIMEOUT_MS = 5000;

/** Lists model ids exposed by a provider, or null when it can't be determined. */
async function listModels(
  type: string,
  baseUrl: string | undefined,
  key: string,
  apiVersion: string | undefined,
): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    let url: string;
    let headers: Record<string, string>;
    if (type === 'anthropic') {
      url = 'https://api.anthropic.com/v1/models';
      headers = { 'x-api-key': key, 'anthropic-version': apiVersion ?? '2023-06-01' };
    } else {
      const base = (baseUrl ?? '').replace(/\/+$/, '');
      if (base.length === 0) {
        return null;
      }
      url = `${base}/models`;
      headers = { authorization: `Bearer ${key}` };
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates every configured provider's pinned model id against its live model
 * list and warns on any mismatch. De-dupes by endpoint+key so a good+fast pair
 * sharing one key only lists once. Best-effort: returns silently on any error,
 * skips mock/ollama/keyless providers, and never throws.
 */
export async function validateConfiguredModels(deps: CliDeps): Promise<void> {
  let providers: Record<string, { type: string; baseUrl?: string; apiKeyEnv?: string; model?: string; apiVersion?: string }>;
  try {
    providers = loadGatewayContext(deps.cwd()).providers.providers as typeof providers;
  } catch {
    return;
  }
  const cache = new Map<string, string[] | null>();
  for (const name of Object.keys(providers)) {
    if (RESERVED.has(name)) {
      continue;
    }
    const cfg = providers[name];
    if (cfg === undefined || cfg.type === 'mock' || cfg.type === 'ollama') {
      continue;
    }
    const { model, apiKeyEnv } = cfg;
    if (model === undefined || apiKeyEnv === undefined) {
      continue;
    }
    const key = deps.env[apiKeyEnv];
    if (key === undefined || key.length === 0) {
      continue;
    }
    const cacheKey = `${cfg.type}|${cfg.baseUrl ?? ''}|${apiKeyEnv}`;
    let ids = cache.get(cacheKey);
    if (ids === undefined) {
      ids = await listModels(cfg.type, cfg.baseUrl, key, cfg.apiVersion);
      cache.set(cacheKey, ids);
    }
    if (ids !== null && !ids.includes(model)) {
      // i18n: kept literal until Phase 4 (en.ts is being edited concurrently).
      deps.ui.warn(
        `Model "${model}" (${name}) wasn't in the provider's live model list — it may be renamed or deprecated. Run \`excalibur models setup\` to pick a current one.`,
      );
    }
  }
}
